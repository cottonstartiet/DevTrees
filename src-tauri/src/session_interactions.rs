use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInteraction {
    pub id: String,
    pub created_at: i64,
    #[serde(flatten)]
    pub request: InteractionRequest,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionScope {
    /// The `action` the renderer sends back to pick this scope.
    pub action: String,
    pub label: String,
    pub description: String,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InteractionRequest {
    Permission {
        message: String,
        /// Wire `kind` of the prompt: `read`, `write`, `commands`, `url`, ...
        permission_kind: String,
        /// The path, command, URL, or tool the request is about.
        target: Option<String>,
        /// Copilot's stated reason for the request.
        intention: Option<String>,
        /// Unified diff, for write prompts.
        diff: Option<String>,
        /// Pretty-printed prompt payload, shown behind a disclosure.
        detail: String,
        /// True when managed policy requires a per-request human decision.
        managed: bool,
        /// Approval scopes broader than allow-once, in display order.
        scopes: Vec<PermissionScope>,
    },
    Elicitation {
        message: String,
        schema: Option<Value>,
        url: Option<String>,
        unsupported: Option<String>,
    },
    Question {
        message: String,
        choices: Vec<String>,
        allow_freeform: bool,
    },
    Plan {
        message: String,
        plan: Option<String>,
        actions: Vec<String>,
    },
    AutoMode {
        message: String,
    },
}

impl InteractionRequest {
    pub fn message(&self) -> &str {
        match self {
            Self::Permission { message, .. }
            | Self::Elicitation { message, .. }
            | Self::Question { message, .. }
            | Self::Plan { message, .. }
            | Self::AutoMode { message } => message,
        }
    }

    pub fn validate(&self, answer: &InteractionAnswer) -> AppResult<()> {
        let valid = match (self, answer) {
            (Self::Permission { scopes, .. }, InteractionAnswer::Permission { action }) => {
                matches!(action.as_str(), "allow-once" | "deny")
                    || scopes.iter().any(|scope| scope.action == *action)
            }
            (
                Self::Elicitation {
                    schema,
                    url,
                    unsupported,
                    ..
                },
                InteractionAnswer::Elicitation { action, content },
            ) => {
                if matches!(action.as_str(), "decline" | "cancel") {
                    content.is_none()
                } else if action == "accept" && unsupported.is_none() {
                    if url.is_some() {
                        content.is_none()
                    } else {
                        validate_form(
                            schema
                                .as_ref()
                                .ok_or_else(|| AppError::msg("Missing form schema."))?,
                            content
                                .as_ref()
                                .ok_or_else(|| AppError::msg("A form response is required."))?,
                        )?;
                        true
                    }
                } else {
                    false
                }
            }
            (
                Self::Question {
                    choices,
                    allow_freeform,
                    ..
                },
                InteractionAnswer::Question {
                    answer,
                    was_freeform,
                },
            ) => {
                (!answer.trim().is_empty() && answer.len() <= 1_048_576)
                    && if *was_freeform {
                        *allow_freeform
                    } else {
                        choices.contains(answer)
                    }
            }
            (
                Self::Plan { actions, .. },
                InteractionAnswer::Plan {
                    approved,
                    selected_action,
                    feedback,
                },
            ) => {
                feedback.as_ref().is_none_or(|text| text.len() <= 1_048_576)
                    && if *approved {
                        selected_action
                            .as_ref()
                            .is_some_and(|action| actions.contains(action))
                    } else {
                        selected_action.is_none()
                    }
            }
            (Self::AutoMode { .. }, InteractionAnswer::AutoMode { .. }) => true,
            (_, InteractionAnswer::Cancel) => true,
            _ => false,
        };
        if valid {
            Ok(())
        } else {
            Err(AppError::msg("The response is not valid for this request."))
        }
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InteractionAnswer {
    Permission {
        action: String,
    },
    Elicitation {
        action: String,
        content: Option<Value>,
    },
    Question {
        answer: String,
        was_freeform: bool,
    },
    Plan {
        approved: bool,
        selected_action: Option<String>,
        feedback: Option<String>,
    },
    AutoMode {
        approved: bool,
    },
    Cancel,
}

fn fail(message: impl Into<String>) -> AppError {
    AppError::msg(message)
}

pub fn check_schema(schema: &Value) -> AppResult<()> {
    let root = schema
        .as_object()
        .ok_or_else(|| fail("Expected an object form schema."))?;
    if root.keys().any(|key| {
        ![
            "$schema",
            "type",
            "title",
            "description",
            "properties",
            "required",
            "additionalProperties",
        ]
        .contains(&key.as_str())
    }) {
        return Err(fail(
            "This form uses unsupported schema constraints. End the session, select External Copilot terminal in Settings, then resume from History.",
        ));
    }
    let fields = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| fail("This form has no supported field definitions."))?;
    if fields.len() > 64 || schema.to_string().len() > 262_144 {
        return Err(fail(
            "This form is too large for in-app controls. End the session, select External Copilot terminal in Settings, then resume from History.",
        ));
    }
    if schema.get("type").is_some_and(|value| value != "object") {
        return Err(fail("Only flat object forms are supported."));
    }
    if schema
        .get("additionalProperties")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(fail("Additional field schemas are not supported."));
    }
    if schema.get("required").is_some_and(|value| {
        !value.as_array().is_some_and(|names| {
            names
                .iter()
                .all(|name| name.as_str().is_some_and(|name| fields.contains_key(name)))
        })
    }) {
        return Err(fail("This form has invalid required fields."));
    }
    for (name, field) in fields {
        let object = field
            .as_object()
            .ok_or_else(|| fail(format!("Invalid schema for '{name}'.")))?;
        if object.keys().any(|key| {
            ![
                "type",
                "title",
                "description",
                "default",
                "enum",
                "enumNames",
                "oneOf",
                "items",
                "minLength",
                "maxLength",
                "pattern",
                "minimum",
                "maximum",
                "minItems",
                "maxItems",
                "uniqueItems",
            ]
            .contains(&key.as_str())
        }) {
            return Err(fail(format!(
                "Field '{name}' uses unsupported or sensitive constraints."
            )));
        }
        let kind = field
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| fail(format!("Field '{name}' is missing its type.")))?;
        if !matches!(kind, "string" | "number" | "integer" | "boolean" | "array")
            || field.get("writeOnly") == Some(&Value::Bool(true))
            || field.get("format").and_then(Value::as_str) == Some("password")
        {
            return Err(fail(format!(
                "Field '{name}' requires an unsupported or sensitive input."
            )));
        }
        if kind == "array"
            && field
                .pointer("/items/type")
                .is_some_and(|value| value != "string")
        {
            return Err(fail(format!(
                "Field '{name}' is not a supported multi-select."
            )));
        }
        if kind == "array"
            && field.pointer("/items/enum").is_none()
            && field.pointer("/items/anyOf").is_none()
        {
            return Err(fail(format!(
                "Field '{name}' needs explicit multi-select choices."
            )));
        }
        if kind == "array"
            && !field
                .get("items")
                .and_then(Value::as_object)
                .is_some_and(|items| {
                    items
                        .keys()
                        .all(|key| ["type", "enum", "anyOf"].contains(&key.as_str()))
                })
        {
            return Err(fail(format!(
                "Field '{name}' has unsupported item constraints."
            )));
        }
        if (field.pointer("/items/enum").is_some() && field.pointer("/items/anyOf").is_some())
            || field
                .get("uniqueItems")
                .is_some_and(|value| !value.is_boolean())
        {
            return Err(fail(format!(
                "Field '{name}' has invalid multi-select constraints."
            )));
        }
        for key in ["title", "description", "pattern"] {
            if field.get(key).is_some_and(|value| !value.is_string()) {
                return Err(fail(format!("Field '{name}' has an invalid {key}.")));
            }
        }
        for key in ["minLength", "maxLength", "minItems", "maxItems"] {
            if field.get(key).is_some_and(|value| value.as_u64().is_none()) {
                return Err(fail(format!("Field '{name}' has an invalid {key}.")));
            }
        }
        for key in ["minimum", "maximum"] {
            if field
                .get(key)
                .is_some_and(|value| !value.as_f64().is_some_and(f64::is_finite))
            {
                return Err(fail(format!("Field '{name}' has an invalid {key}.")));
            }
        }
        for (minimum, maximum) in [
            ("minLength", "maxLength"),
            ("minItems", "maxItems"),
            ("minimum", "maximum"),
        ] {
            if let (Some(min), Some(max)) = (
                field.get(minimum).and_then(Value::as_f64),
                field.get(maximum).and_then(Value::as_f64),
            ) {
                if min > max {
                    return Err(fail(format!("Field '{name}' has contradictory limits.")));
                }
            }
        }
        if (kind != "string"
            && [
                "minLength",
                "maxLength",
                "pattern",
                "enum",
                "enumNames",
                "oneOf",
            ]
            .iter()
            .any(|key| field.get(key).is_some()))
            || (kind != "array"
                && ["items", "minItems", "maxItems", "uniqueItems"]
                    .iter()
                    .any(|key| field.get(key).is_some()))
            || (!matches!(kind, "integer" | "number")
                && ["minimum", "maximum"]
                    .iter()
                    .any(|key| field.get(key).is_some()))
            || (field.get("enum").is_some() && field.get("oneOf").is_some())
        {
            return Err(fail(format!(
                "Field '{name}' combines incompatible constraints."
            )));
        }
        if let Some(pattern) = field.get("pattern").and_then(Value::as_str) {
            regex::RegexBuilder::new(pattern)
                .size_limit(262_144)
                .build()
                .map_err(|_| fail(format!("Field '{name}' has an unsupported pattern.")))?;
        }
        if let Some(options) = field.get("enum").or_else(|| field.pointer("/items/enum")) {
            if !options.as_array().is_some_and(|items| {
                !items.is_empty()
                    && items.len() <= 256
                    && items
                        .iter()
                        .enumerate()
                        .all(|(index, item)| item.is_string() && !items[..index].contains(item))
            }) {
                return Err(fail(format!("Field '{name}' has unsupported choices.")));
            }
        }
        if let Some(options) = field.get("oneOf").or_else(|| field.pointer("/items/anyOf")) {
            if !options.as_array().is_some_and(|items| {
                !items.is_empty()
                    && items.len() <= 256
                    && items.iter().enumerate().all(|(index, item)| {
                        item.as_object().is_some_and(|option| {
                            option.get("const").is_some_and(Value::is_string)
                                && !items[..index]
                                    .iter()
                                    .any(|prior| prior.get("const") == option.get("const"))
                                && option.get("title").is_none_or(Value::is_string)
                                && option
                                    .keys()
                                    .all(|key| ["const", "title"].contains(&key.as_str()))
                        })
                    })
            }) {
                return Err(fail(format!("Field '{name}' has unsupported choices.")));
            }
        }
        if field.get("enumNames").is_some_and(|names| {
            !names.as_array().is_some_and(|names| {
                names.iter().all(Value::is_string)
                    && field["enum"]
                        .as_array()
                        .is_some_and(|values| names.len() == values.len())
            })
        }) {
            return Err(fail(format!("Field '{name}' has invalid choice labels.")));
        }
    }
    Ok(())
}

fn allowed_choice(field: &Value, value: &Value, alternatives: &str) -> bool {
    if let Some(options) = field.get("enum").and_then(Value::as_array) {
        return options.contains(value);
    }
    if let Some(options) = field.get(alternatives).and_then(Value::as_array) {
        return options
            .iter()
            .any(|option| option.get("const") == Some(value));
    }
    true
}

pub fn validate_form(schema: &Value, content: &Value) -> AppResult<()> {
    check_schema(schema)?;
    let values = content
        .as_object()
        .ok_or_else(|| fail("Expected an object response."))?;
    if content.to_string().len() > 1_048_576 {
        return Err(fail("The form response is too large."));
    }
    let fields = schema["properties"]
        .as_object()
        .ok_or_else(|| fail("Missing form fields."))?;
    if values.keys().any(|key| !fields.contains_key(key)) {
        return Err(fail("The response contains an unknown field."));
    }
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for name in required.iter().filter_map(Value::as_str) {
            if !values.contains_key(name) || values[name].is_null() {
                return Err(fail(format!("'{name}' is required.")));
            }
        }
    }
    for (name, value) in values {
        let field = &fields[name];
        let kind = field
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("string");
        let valid = match kind {
            "string" => value.as_str().is_some_and(|text| {
                let length = text.chars().count() as u64;
                field
                    .get("minLength")
                    .and_then(Value::as_u64)
                    .is_none_or(|n| length >= n)
                    && field
                        .get("maxLength")
                        .and_then(Value::as_u64)
                        .is_none_or(|n| length <= n)
                    && field
                        .get("pattern")
                        .and_then(Value::as_str)
                        .is_none_or(|pattern| {
                            regex::RegexBuilder::new(pattern)
                                .size_limit(262_144)
                                .build()
                                .is_ok_and(|regex| regex.is_match(text))
                        })
            }),
            "boolean" => value.is_boolean(),
            "integer" | "number" => value.as_f64().is_some_and(|number| {
                number.is_finite()
                    && (kind != "integer" || number.fract() == 0.0)
                    && field
                        .get("minimum")
                        .and_then(Value::as_f64)
                        .is_none_or(|n| number >= n)
                    && field
                        .get("maximum")
                        .and_then(Value::as_f64)
                        .is_none_or(|n| number <= n)
            }),
            "array" => value.as_array().is_some_and(|items| {
                let size = items.len() as u64;
                field
                    .get("minItems")
                    .and_then(Value::as_u64)
                    .is_none_or(|n| size >= n)
                    && field
                        .get("maxItems")
                        .and_then(Value::as_u64)
                        .is_none_or(|n| size <= n)
                    && items.iter().enumerate().all(|(index, item)| {
                        item.is_string()
                            && !items[..index].contains(item)
                            && allowed_choice(&field["items"], item, "anyOf")
                    })
            }),
            _ => false,
        };
        if !valid || !allowed_choice(field, value, "oneOf") {
            return Err(fail(format!("Check the value for '{name}'.")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_typed_form_values_and_constraints() {
        let schema = json!({"type":"object","required":["count"],"properties":{
            "count":{"type":"integer","minimum":1},
            "enabled":{"type":"boolean"},
            "tags":{"type":"array","items":{"type":"string","enum":["alpha","beta"]}}
        }});
        assert!(
            validate_form(&schema, &json!({"count":7,"enabled":true,"tags":["alpha"]})).is_ok()
        );
        for content in [
            json!({}),
            json!({"count":1.5}),
            json!({"count":0}),
            json!({"count":7,"enabled":"true"}),
            json!({"count":7,"tags":["gamma"]}),
            json!({"count":7,"tags":["alpha","alpha"]}),
            json!({"count":7,"extra":"x"}),
        ] {
            assert!(validate_form(&schema, &content).is_err(), "{content}");
        }
    }

    #[test]
    fn cannot_invent_a_session_approval_or_plan_action() {
        let permission = InteractionRequest::Permission {
            message: "Run command".into(),
            permission_kind: "commands".into(),
            target: None,
            intention: None,
            diff: None,
            detail: String::new(),
            managed: false,
            scopes: Vec::new(),
        };
        for action in ["allow-session", "allow-always"] {
            assert!(permission
                .validate(&InteractionAnswer::Permission {
                    action: action.into()
                })
                .is_err());
        }
        for action in ["allow-once", "deny"] {
            assert!(permission
                .validate(&InteractionAnswer::Permission {
                    action: action.into()
                })
                .is_ok());
        }
        let offered = InteractionRequest::Permission {
            message: "Read file".into(),
            permission_kind: "read".into(),
            target: None,
            intention: None,
            diff: None,
            detail: String::new(),
            managed: false,
            scopes: vec![PermissionScope {
                action: "allow-session".into(),
                label: "Allow for this session".into(),
                description: String::new(),
            }],
        };
        assert!(offered
            .validate(&InteractionAnswer::Permission {
                action: "allow-session".into()
            })
            .is_ok());
        assert!(offered
            .validate(&InteractionAnswer::Permission {
                action: "allow-always".into()
            })
            .is_err());
        let plan = InteractionRequest::Plan {
            message: String::new(),
            plan: None,
            actions: vec!["interactive".into()],
        };
        assert!(plan
            .validate(&InteractionAnswer::Plan {
                approved: true,
                selected_action: Some("autopilot".into()),
                feedback: None
            })
            .is_err());
        assert!(plan.validate(&InteractionAnswer::Cancel).is_ok());
    }

    #[test]
    fn unsupported_schema_constraints_are_not_silently_ignored() {
        for field in [
            json!({"type":"string","format":"password"}),
            json!({"type":"object","properties":{}}),
            json!({"type":"number","exclusiveMinimum":0}),
            json!({"type":"string","maxLength":"4"}),
            json!({"type":"string","pattern":"(?=unsafe)"}),
            json!({"type":"string","oneOf":[{"const":"a","minLength":10}]}),
            json!({"type":"string","minLength":5,"maxLength":2}),
            json!({"type":"array","items":{"type":"string","enum":["a"],"pattern":"a"}}),
            json!({"description":"missing type"}),
            json!({"type":"string","enum":["a","a"]}),
            json!({"type":"string","enum":["a"],"enumNames":[1]}),
            json!({"type":"string","oneOf":[{"const":"a"},{"const":"a"}]}),
            json!({"type":"array","items":{"enum":["a"],"anyOf":[{"const":"b"}]}}),
            json!({"type":"array","items":{"enum":["a"]},"uniqueItems":"yes"}),
        ] {
            assert!(
                check_schema(&json!({"properties":{"field":field}})).is_err(),
                "{field}"
            );
        }
        assert!(check_schema(&json!({"required":["missing"],"properties":{}})).is_err());
    }
}
