use serde::Deserialize;
use tauri::{AppHandle, Runtime};

#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;

const MAX_TITLE_LENGTH: usize = 200;
const MAX_BODY_LENGTH: usize = 240;
#[cfg(windows)]
const POWERSHELL_APP_ID: &str =
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DesktopNotificationDestination {
    Dashboard,
}

impl DesktopNotificationDestination {
    fn deep_link(self) -> &'static str {
        match self {
            Self::Dashboard => "devtrees://navigate/dashboard",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopNotificationRequest {
    title: String,
    body: String,
    destination: DesktopNotificationDestination,
}

fn compact_text(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max_chars {
        return compact;
    }

    let mut truncated = compact
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>();
    truncated.push_str("...");
    truncated
}

fn normalized_request(
    request: DesktopNotificationRequest,
) -> Result<(String, String, DesktopNotificationDestination), String> {
    let title = compact_text(&request.title, MAX_TITLE_LENGTH);
    let body = compact_text(&request.body, MAX_BODY_LENGTH);
    if title.is_empty() {
        return Err("Desktop notification title cannot be empty.".to_string());
    }
    if body.is_empty() {
        return Err("Desktop notification body cannot be empty.".to_string());
    }
    Ok((title, body, request.destination))
}

#[cfg(windows)]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(windows)]
fn toast_xml(title: &str, body: &str, destination: DesktopNotificationDestination) -> String {
    format!(
        r#"<toast launch="{}" activationType="protocol">
            <visual>
                <binding template="ToastGeneric">
                    <text>{}</text>
                    <text>{}</text>
                </binding>
            </visual>
        </toast>"#,
        destination.deep_link(),
        xml_escape(title),
        xml_escape(body)
    )
}

#[cfg(windows)]
fn show<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    destination: DesktopNotificationDestination,
) -> Result<(), String> {
    use windows::{
        core::HSTRING,
        Data::Xml::Dom::XmlDocument,
        UI::Notifications::{ToastNotification, ToastNotificationManager},
    };

    let document = XmlDocument::new()
        .map_err(|error| format!("Could not create the notification document: {error}"))?;
    document
        .LoadXml(&HSTRING::from(toast_xml(title, body, destination)))
        .map_err(|error| format!("Could not prepare the notification: {error}"))?;
    let toast = ToastNotification::CreateToastNotification(&document)
        .map_err(|error| format!("Could not create the notification: {error}"))?;
    // Unpackaged dev builds have no Start Menu AUMID; match the plugin's fallback identity.
    let app_id = if tauri::is_dev() {
        POWERSHELL_APP_ID
    } else {
        &app.config().identifier
    };
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
        .map_err(|error| format!("Could not access Windows notifications: {error}"))?;
    notifier
        .Show(&toast)
        .map_err(|error| format!("Could not show the notification: {error}"))
}

#[cfg(not(windows))]
fn show<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    _destination: DesktopNotificationDestination,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("Could not show the notification: {error}"))
}

#[tauri::command]
pub(crate) fn desktop_notification_show<R: Runtime>(
    app: AppHandle<R>,
    request: DesktopNotificationRequest,
) -> Result<(), String> {
    let (title, body, destination) = normalized_request(request)?;
    show(&app, &title, &body, destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_and_truncates_notification_text() {
        assert_eq!(compact_text("  needs\n  input  ", 20), "needs input");
        assert_eq!(compact_text("abcdefghij", 8), "abcde...");
    }

    #[test]
    fn rejects_empty_notification_content() {
        let result = normalized_request(DesktopNotificationRequest {
            title: " \n ".to_string(),
            body: "Needs input".to_string(),
            destination: DesktopNotificationDestination::Dashboard,
        });
        assert_eq!(
            result.expect_err("empty title should be rejected"),
            "Desktop notification title cannot be empty."
        );
    }

    #[cfg(windows)]
    #[test]
    fn toast_xml_escapes_text_and_uses_allowlisted_route() {
        use windows::{
            core::HSTRING, Data::Xml::Dom::XmlDocument, UI::Notifications::ToastNotification,
        };

        let xml = toast_xml(
            "A & B",
            "<answer> \"now\"",
            DesktopNotificationDestination::Dashboard,
        );
        assert!(xml.contains(r#"launch="devtrees://navigate/dashboard""#));
        assert!(xml.contains("A &amp; B"));
        assert!(xml.contains("&lt;answer&gt; &quot;now&quot;"));
        assert!(!xml.contains("<answer>"));

        let document = XmlDocument::new().expect("create notification XML document");
        document
            .LoadXml(&HSTRING::from(xml))
            .expect("load protocol-activated toast XML");
        ToastNotification::CreateToastNotification(&document)
            .expect("create protocol-activated toast");
    }
}
