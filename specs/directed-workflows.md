# Directed Workflows and Visualization

## Status

Proposed

## Summary

DevTrees will add a repository-scoped directed workflow system inspired by
Conductor. Workflow definitions are YAML files discovered under:

```text
.github/dt-workflows/**/*.yml
.github/dt-workflows/**/*.yaml
```

The Tauri backend will parse and validate a documented Conductor-compatible
subset, execute workflows through a native Rust engine, use the existing
GitHub Copilot ACP runtime for agent steps, persist run state and append-only
events in SQLite, and expose a live workflow graph in the React renderer.

The first implementation supports:

- multiple workflow definitions per repository;
- up to four active workflow runs, with excess launches queued;
- directed and conditional routes;
- Copilot agent, set, script, wait, human gate, questions, terminate, nested
  workflow, static parallel, and dynamic for-each steps;
- up to five concurrent agent executions within one run;
- stop, kill, checkpoint, resume, history, and replay;
- hash-based trust for workflow files containing local script steps;
- an interactive React Flow graph with nested workflow drill-down.

DevTrees does not invoke or embed the Conductor executable. Compatibility is
intentional but bounded. Unsupported Conductor fields must produce validation
errors instead of being ignored.

## Motivation

DevTrees already coordinates repositories, worktrees, tasks, and individual
Copilot sessions. A developer can start several independent sessions, but
cannot describe a repeatable multi-step process such as:

1. inspect a worktree;
2. ask multiple agents to investigate different areas;
3. synthesize the findings;
4. pause for approval;
5. execute or terminate based on the decision.

Without a workflow model:

- orchestration remains implicit in prompts or manual user actions;
- multi-agent sequences cannot be reused or source-controlled;
- there is no visual representation of current or possible execution paths;
- a run cannot be paused and resumed at a deterministic step boundary;
- concurrent work is visible as unrelated sessions rather than one process.

Conductor demonstrates the useful architectural separation:

- YAML is the declarative source of topology and behavior;
- a deterministic engine owns routing and context;
- agent providers execute work but do not decide orchestration;
- lifecycle events are the source for live visualization and replay;
- run management is separate from per-run graph detail.

DevTrees should adopt those boundaries while reusing its existing ACP and
desktop persistence infrastructure.

## Goals

1. Discover valid workflow definitions from every registered repository.
2. Show invalid workflow files with actionable source diagnostics.
3. Launch a workflow against a selected repository worktree with typed inputs.
4. Execute routing deterministically without using an LLM as the orchestrator.
5. Reuse DevTrees' existing Copilot ACP session implementation for agent work.
6. Run several workflows and parallel agent branches safely.
7. Persist enough state to recover from an app restart at a step boundary.
8. Show the full workflow topology and live path in an interactive graph.
9. Surface human gates and questions as first-class attention requests.
10. Preserve completed run history and support event replay.
11. Make script execution explicit, inspectable, and revocable.
12. Keep the new surface aligned with the Developer Cockpit design system.

## Non-goals

- A drag-and-drop workflow authoring canvas.
- Editing and round-tripping workflow YAML inside DevTrees.
- Full compatibility with every current or future Conductor field.
- Providers other than GitHub Copilot ACP.
- Running workflow orchestration in the renderer.
- A local HTTP or WebSocket service.
- Multi-user or remote workflow monitoring.
- A cloud scheduler or unattended machine-wide daemon.
- Loading workflows from a global user directory or remote registry.
- Automatic execution triggered by git, PR, timer, or filesystem events.
- Sharing one live ACP session between unrelated workflow nodes or runs.
- Structured model-output schema enforcement in the initial compatibility
  release.

## Product principles

### Source-controlled behavior

The repository YAML file is the definition source of truth. DevTrees stores an
immutable YAML snapshot and hash with each run so history and resume always
refer to the exact launched definition.

### Deterministic orchestration

The Rust engine decides what executes next. Agents produce output; they do not
select the next node unless a declared route condition reads their output.
Routes are evaluated in declaration order and the first matching route wins.

### True state

The UI must distinguish queued, starting, running, waiting for input, stopping,
paused, completed, failed, and cancelled states. It must not present a missing
terminal event or stale ACP row as evidence that work is still running.

### Recover at boundaries

The engine checkpoints after stable step boundaries and before parking on
human input. Resume continues from durable state. It does not attempt to
pretend an interrupted local process or unconfirmed ACP turn completed.

### Graph as projection

The graph is generated from the normalized definition and updated from
persisted run events. The renderer never computes routing, completion, retry,
or resume decisions.

## Terminology

| Term              | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| Definition        | A parsed workflow YAML file and its normalized static topology.  |
| Run               | One launched execution of one immutable definition revision.     |
| Step              | A named executable definition such as an agent, script, or gate. |
| Group             | A named static parallel or dynamic for-each execution unit.      |
| Node address      | A step name plus its nested sub-workflow/iteration path.         |
| Context           | Workflow inputs, metadata, prior outputs, and execution history. |
| Event             | One append-only lifecycle record with a per-run sequence number. |
| Snapshot          | Materialized current run state derived from committed events.    |
| Checkpoint        | Durable engine state from which a paused run can resume.         |
| Attention request | A persisted human gate or questions interaction.                 |

## Discovery and identity

### Discovery root

For every repository stored by DevTrees, scan its working repository path:

```text
<repository>\.github\dt-workflows\
```

The scan is recursive and includes case-insensitive `.yml` and `.yaml`
extensions.

### Catalog identity

A catalog entry is identified by:

```text
repository_id + normalized repository-relative path
```

The content revision is identified by SHA-256 over the raw YAML bytes:

```text
sha256:<lowercase hex>
```

The path identity remains stable across edits. Trust and run snapshots use the
content hash so an edit cannot silently inherit old executable trust.

### Scan behavior

- Missing `.github/dt-workflows` is a normal empty state.
- An unreadable directory produces one repository-level diagnostic.
- An unreadable file remains visible as an invalid catalog item.
- One invalid file does not prevent other definitions from loading.
- Symbolic links that resolve outside the repository root are ignored with a
  diagnostic.
- Nested workflow references must resolve to regular files inside the same
  repository.
- The first implementation rescans on repository refresh, Workflows-page
  refresh, app startup, and successful return to the app after an external file
  edit. It does not add a filesystem watcher.

### Catalog result

```ts
export type WorkflowCatalogItem = {
  repositoryId: string
  repositoryName: string
  relativePath: string
  absolutePath: string
  hash: string | null
  name: string | null
  description: string | null
  version: string | null
  valid: boolean
  hasScripts: boolean
  inputCount: number
  nodeCount: number
  diagnostics: WorkflowDiagnostic[]
}
```

Invalid files use `null` for fields that could not be recovered.

## Compatibility contract

### Supported top-level shape

```yaml
workflow:
  name: example
  description: Optional text
  version: '1.0.0'
  entry_point: first_step
  input: {}
  runtime:
    provider: copilot
    working_dir: .
  limits:
    max_iterations: 20
    timeout_seconds: 1800

agents: []
parallel: []
for_each: []
output: {}
```

### Supported workflow fields

| Field                    | Required | Behavior                                                  |
| ------------------------ | -------: | --------------------------------------------------------- |
| `name`                   |      Yes | Non-empty display and diagnostic name.                    |
| `description`            |       No | Catalog and launch detail text.                           |
| `version`                |       No | Informational string.                                     |
| `entry_point`            |      Yes | Must name an agent, parallel group, or for-each group.    |
| `input`                  |       No | Typed launch input definitions.                           |
| `runtime.provider`       |       No | Defaults to `copilot`; any other value is rejected.       |
| `runtime.working_dir`    |       No | Relative to selected run worktree; must remain inside it. |
| `limits.max_iterations`  |       No | Defaults to 20; range 1-500.                              |
| `limits.timeout_seconds` |       No | Optional whole seconds; range 1-86400.                    |
| `output`                 |       No | Final rendered JSON-compatible mapping.                   |

Fields present in Conductor but outside this table are rejected during the
initial release. The diagnostic must name the unsupported field.

### Input definitions

Supported types:

- `string`
- `number`
- `boolean`
- `array`
- `object`

```yaml
workflow:
  input:
    objective:
      type: string
      description: What the workflow should investigate.
      required: true
      default: Optional default
```

Rules:

- `type` is required.
- `required` defaults to `true`.
- A default must match the declared type.
- A required field may have a default.
- Arrays and objects are entered as JSON in the initial launch form.
- Unknown input fields supplied at launch are rejected.
- Renderer validation is advisory; Rust validation is authoritative.

### Template context

The template engine exposes:

```text
workflow.input.<name>
workflow.dir
workflow.file
workflow.name
context.iteration
context.history
<step>.output
<group>.outputs
<group>.errors
output
```

`output` is defined only while evaluating routes attached to the step or group
that just completed.

Missing required values are errors. An optional reference may be represented
by a supported `default` filter or an explicitly optional input declaration.
The engine must not convert an undefined path to an empty string silently.

### Supported template operations

Initial support includes:

- variable lookup and nested object/array lookup;
- string interpolation;
- boolean, numeric, string, and null literals;
- `and`, `or`, and `not`;
- equality and ordering comparisons;
- list membership;
- parentheses;
- `default`, `length`, `lower`, `upper`, `trim`, and JSON serialization
  filters.

Any template or condition that cannot be compiled during validation is an
error. Runtime lookup failures identify the node and expression.

### Route semantics

```yaml
routes:
  - to: accepted
    when: '{{ output.approved }}'
  - to: rejected
```

Rules:

1. Routes are evaluated in file order.
2. The first condition evaluating to true wins.
3. A route without `when` always matches.
4. `$end` is a reserved terminal target.
5. A non-terminal step with no routes implicitly targets `$end`.
6. A route target must exist in the same workflow context.
7. A route condition error fails the run; it does not fall through.
8. Validation warns when an unconditional route makes later routes
   unreachable.

### Context modes

The initial implementation uses accumulated context only. Every completed
named step output remains available to later steps in the same workflow
context. Conductor context modes other than accumulation are rejected until
implemented explicitly.

### Agent output

An ACP agent's final assistant Markdown is stored as:

```json
{
  "result": "assistant response"
}
```

The initial release does not support an agent `output` schema or provider-side
structured-output recovery. A definition containing an agent `output` block
is invalid, preventing false compatibility.

## Definition model

### Step types

```rust
enum StepDefinition {
    Agent(AgentStep),
    HumanGate(HumanGateStep),
    Questions(QuestionsStep),
    Script(ScriptStep),
    Set(SetStep),
    Wait(WaitStep),
    Terminate(TerminateStep),
    Workflow(WorkflowStep),
}
```

Parallel and for-each groups are addressable routing targets but are stored in
separate collections because their execution and graph containment semantics
differ from ordinary steps.

### Static topology

The normalized definition includes:

```rust
struct CompiledWorkflow {
    source: WorkflowSource,
    metadata: WorkflowMetadata,
    inputs: IndexMap<String, InputDefinition>,
    entry_point: TargetName,
    steps: IndexMap<String, StepDefinition>,
    parallel_groups: IndexMap<String, ParallelGroupDefinition>,
    for_each_groups: IndexMap<String, ForEachDefinition>,
    output: IndexMap<String, CompiledTemplate>,
    graph: StaticGraph,
    hash: String,
}
```

Use order-preserving maps where declaration order affects display or behavior.

### Validation diagnostics

```ts
export type WorkflowDiagnostic = {
  severity: 'error' | 'warning'
  code: string
  message: string
  relativePath: string
  line?: number
  column?: number
  nodeName?: string
  fieldPath?: string
}
```

Required diagnostic codes include:

- `yaml-invalid`
- `unsupported-field`
- `unsupported-provider`
- `duplicate-name`
- `missing-entry-point`
- `unknown-route-target`
- `invalid-step-fields`
- `invalid-input-default`
- `template-invalid`
- `unreachable-route`
- `nested-workflow-outside-repository`
- `nested-workflow-cycle`
- `nested-workflow-depth`

## Runtime identity

### Run ID

Use a UUID v4 string generated before the run row is inserted.

### Node address

A node name alone is not unique when workflows are nested or for-each items
repeat an inline step. Use:

```ts
export type WorkflowNodeAddress = {
  contextPath: WorkflowContextSegment[]
  name: string
}

export type WorkflowContextSegment =
  | { kind: 'workflow'; step: string; invocation: number }
  | { kind: 'forEach'; group: string; key: string; index: number }
```

The stable serialized node key is JSON, not string concatenation:

```text
JSON.stringify([contextPath, name])
```

This avoids delimiter collisions and keeps renderer/backend identity
consistent.

### Session ownership

Every ACP session created for a workflow node stores:

- `workflow_run_id`;
- serialized node address;
- definition hash;
- selected worktree path.

A run may cancel or end only sessions with its own run ID.

## Run state machine

```text
queued -> starting -> running -> completed
                    |       \-> failed
                    |       \-> stopping -> paused
                    |       \-> stopping -> cancelled
                    \-> waiting_input -> running
                                      \-> stopping

paused -> queued -> starting -> running
queued -> cancelled
```

### States

| Status          | Meaning                                                        |
| --------------- | -------------------------------------------------------------- |
| `queued`        | Persisted and waiting for a global run permit.                 |
| `starting`      | Permit acquired; definition and checkpoint are being prepared. |
| `running`       | At least one executable unit can make progress.                |
| `waiting_input` | All progress is parked on a workflow gate/questions request.   |
| `stopping`      | Graceful cancellation is in progress.                          |
| `paused`        | Durable, resumable checkpoint exists and no node is executing. |
| `completed`     | Terminal success.                                              |
| `failed`        | Terminal error or explicit failed termination.                 |
| `cancelled`     | User killed/cancelled the run; not resumable.                  |

### Valid controls

| State         | Stop | Kill/cancel |               Resume |
| ------------- | ---: | ----------: | -------------------: |
| queued        |   No |         Yes |                   No |
| starting      |  Yes |         Yes |                   No |
| running       |  Yes |         Yes |                   No |
| waiting_input |  Yes |         Yes |                   No |
| stopping      |   No |         Yes |                   No |
| paused        |   No |         Yes |                  Yes |
| completed     |   No |          No |                   No |
| failed        |   No |          No | Checkpoint-dependent |
| cancelled     |   No |          No |                   No |

Failure resume is allowed only when a valid recoverable checkpoint was written.
An explicit failed `terminate` node is never resumable.

### Stop

Stop is graceful:

1. atomically change the run to `stopping`;
2. prevent new nodes from starting;
3. request cancellation of active ACP turns and local processes;
4. wait up to 20 seconds for acknowledgement;
5. persist uncertain in-flight nodes as resumable pending work;
6. write a checkpoint;
7. change the run to `paused`.

If acknowledgement times out, Stop returns an actionable error and the run
remains `stopping`; Kill remains available.

### Kill

Kill is terminal:

1. cancel scheduling;
2. terminate workflow-owned child processes;
3. end workflow-owned ACP sessions;
4. mark active and pending branches cancelled;
5. emit a terminal cancellation event;
6. remove resumability.

### Resume

Resume requires:

- run state is `paused` or a recoverable `failed`;
- saved definition hash equals the current file hash;
- selected repository and worktree still exist;
- checkpoint version is supported.

Resume requeues the run. It does not bypass the global concurrency cap.

If the workflow file changed, the user must launch a new run. DevTrees must not
resume old context against new topology.

## Scheduling and concurrency

### Global scheduler

- Maximum active runs: 4.
- Queue ordering: durable FIFO by `queued_at`, then run ID.
- A resumed run joins the queue at resume time.
- Terminal or paused runs release their global permit.
- The scheduler starts automatically after app setup and whenever capacity is
  released.

### Per-run concurrency

- Maximum concurrent agent-like executions: 5.
- Static parallel and for-each nodes share the same run semaphore.
- Local set and terminate steps do not consume an agent permit.
- Scripts consume a branch execution slot but not an ACP agent permit.
- A nested workflow shares the parent run's semaphore.
- A YAML `max_concurrent` value may reduce but never increase the cap of 5.

### Deterministic aggregation

Parallel results are stored by declared member order, not completion order.
For-each outputs are stored by original item order. Events retain real
completion timestamps, but context rendering remains deterministic.

## Execution context

```rust
struct WorkflowContext {
    inputs: Value,
    outputs: IndexMap<String, Value>,
    history: Vec<NodeAddress>,
    iteration: u32,
}
```

Each nested workflow invocation owns a child context with mapped inputs. The
parent receives only the child workflow's rendered final output.

Context changes are persisted only through the event transaction. Executors
return outcomes; they do not mutate global run state directly.

## Step semantics

### Agent

```yaml
- name: investigate
  type: agent
  description: Inspect the worktree.
  working_dir: .
  prompt: |
    Investigate {{ workflow.input.objective }}.
  routes:
    - to: review
```

Behavior:

1. Render `working_dir`, system prompt if supported, and prompt.
2. Verify the resolved working directory is inside the selected worktree.
3. Create a workflow-owned ACP session or resume its saved session.
4. Submit one prompt with a stable submission ID derived from run/node/attempt.
5. Wait for the active queued prompt to become completed, failed,
   delivery-unknown, or cancelled.
6. Extract the final assistant text associated with that prompt.
7. Store `{ result }` and available usage.

An ACP permission or elicitation request uses the existing native session
interaction mechanism. The workflow node remains `running`; the run list shows
an attention indicator because an ACP interaction is pending.

The workflow engine does not auto-approve permissions.

### Set

```yaml
- name: prepare
  type: set
  value: '{{ workflow.input.objective }}'
  routes:
    - to: investigate
```

or:

```yaml
- name: prepare
  type: set
  values:
    objective: '{{ workflow.input.objective }}'
    safe: true
```

Exactly one of `value` or `values` is required. Values are rendered against
the same pre-step context so keys in one `values` block cannot depend on a
sibling key's newly rendered value.

### Human gate

```yaml
- name: review
  type: human_gate
  prompt: Review the result.
  options:
    - label: Accept
      value: accepted
      route: complete
    - label: Reject
      value: rejected
      route: rejected
      prompt_for: feedback
```

Rules:

- At least two options are required.
- Values are unique within the gate.
- A route may be declared on the selected option.
- `prompt_for` requests additional text after selecting the option.
- The output contains `choice`, `label`, and optional `additional_input`.
- An option route takes precedence over the gate's ordinary `routes`.
- The request is persisted before the run changes to `waiting_input`.
- A response includes the run revision and request ID; stale responses fail.
- Rejection/cancel choices render before approval choices.
- No approval choice receives automatic focus.

### Questions

```yaml
- name: requirements
  type: questions
  questions:
    - id: target
      prompt: Which target should be used?
      type: single_select
      options:
        - label: Main
          value: main
        - label: Develop
          value: develop
  allow_back: true
  allow_skip: true
  allow_abort: false
```

Initial question types:

- free text;
- single select;
- multi-select;
- boolean.

Persist the current index and answers after every action. Back replaces an
existing answer rather than appending a second outcome. Output includes:

```json
{
  "answers": {},
  "answered_count": 0,
  "skipped_count": 0,
  "answered_any": false
}
```

Dynamic question sources are deferred; the initial release supports inline
questions only.

### Script

```yaml
- name: inspect
  type: script
  command: git
  args: ['status', '--short']
  env:
    MODE: '{{ workflow.input.mode }}'
  working_dir: .
  timeout_seconds: 60
```

Rules:

- `command` is a program name or rendered absolute path.
- Arguments are passed separately through `tokio::process::Command`.
- No implicit shell is used.
- Environment key names are validated.
- Environment values may be rendered but are never written to events.
- Working directory must remain inside the selected worktree.
- stdout and stderr are individually capped at 1 MiB.
- Timeout defaults to 300 seconds and cannot exceed the run timeout.
- Output contains `stdout`, `stderr`, `exit_code`, and truncation flags.
- A non-zero exit code fails the node unless a route explicitly supports
  exit-code handling through the output.

Before launch, every reachable script command is included in the workflow
trust prompt. Trust is granted to the definition hash, not only the path.

### Wait

```yaml
- name: cool_down
  type: wait
  duration_seconds: 30
  reason: Wait for remote state to settle.
```

The checkpoint stores an absolute target timestamp. Resume waits the remaining
duration and completes immediately if the timestamp has passed.

### Terminate

```yaml
- name: complete
  type: terminate
  status: success
  reason: The result was approved.
  output_template:
    result: accepted
```

`status` is `success` or `failed`. A terminate node does not evaluate routes.
It emits a terminal event with `isExplicit: true`, the rendered reason, node
address, and rendered output.

### Static parallel

```yaml
parallel:
  - name: investigate_areas
    agents: [frontend, backend]
    failure_mode: fail_fast
    routes:
      - to: synthesize
```

Failure modes:

- `fail_fast`: cancel unfinished members after the first failure.
- `continue_on_error`: complete when at least one member succeeds.
- `all_or_nothing`: wait for all members and fail if any member fails.

The group output is:

```json
{
  "outputs": {
    "frontend": {},
    "backend": {}
  },
  "errors": {}
}
```

A step used as a parallel member cannot also execute independently in the same
group invocation. The validator rejects nested static parallel groups in the
initial release.

### Dynamic for-each

```yaml
for_each:
  - name: inspect_files
    type: for_each
    source: discover.output.files
    as: file
    max_concurrent: 3
    failure_mode: continue_on_error
    agent:
      name: inspect_file
      type: agent
      prompt: Inspect {{ file.path }}.
    routes:
      - to: synthesize
```

Rules:

- `source` must resolve to an array.
- Every item receives an index and stable key.
- Object key preference: explicit `key_by`, then `id`, then `name`, otherwise
  the numeric index.
- Duplicate derived keys are validation/runtime errors.
- The loop variable is available only inside the inline step.
- Effective concurrency is `min(max_concurrent, 5)`.
- Nested for-each groups are deferred.
- An inline nested workflow is supported after nested workflow phase delivery.

### Nested workflow

```yaml
- name: review_subflow
  type: workflow
  workflow: ./review.yml
  input_mapping:
    report: '{{ investigate.output.result }}'
  max_depth: 5
  routes:
    - to: complete
```

Rules:

- Resolve relative to the parent workflow file.
- Resolved files must remain inside the repository.
- Maximum runtime depth is 10 and a lower per-node `max_depth` may apply.
- Detect direct and indirect static cycles during validation.
- Each invocation has an isolated context and namespaced event path.
- Child explicit failure becomes a failed parent node.
- Child success returns the rendered child workflow output.

## Checkpoint model

Checkpoint JSON is stored in `workflow_runs.checkpoint_json`:

```ts
export type WorkflowCheckpoint = {
  version: 1
  definitionHash: string
  currentTargets: WorkflowNodeAddress[]
  inputs: Record<string, unknown>
  contexts: SerializedWorkflowContext[]
  completedNodes: Record<string, WorkflowNodeResult>
  pendingNodes: Record<string, PendingNodeState>
  iteration: number
  startedAt: number
  timeoutDeadline: number | null
  acpSessions: Record<
    string,
    {
      sessionId: string
      generation: string | null
      workingDirectory: string
      submissionId: string
      deliveryState: string
    }
  >
}
```

Write a checkpoint:

- after every completed node/group;
- before waiting for a workflow interaction;
- after every answered question;
- after Stop has quiesced active work;
- periodically only if later performance testing demonstrates a need.

Checkpoint and materialized run state update in the same SQLite transaction as
the boundary event.

## Persistence

### Schema migration

Increment `PRAGMA user_version` and add idempotent creation/migration logic.
The exact version number is selected against the version present when
implementation begins.

```sql
CREATE TABLE workflow_runs (
    id                  TEXT PRIMARY KEY,
    repository_id       TEXT NOT NULL,
    repository_name     TEXT NOT NULL,
    repository_path     TEXT NOT NULL,
    worktree_path       TEXT NOT NULL,
    workflow_path       TEXT NOT NULL,
    workflow_name       TEXT NOT NULL,
    workflow_version    TEXT,
    definition_hash     TEXT NOT NULL,
    yaml_snapshot       TEXT NOT NULL,
    input_json          TEXT NOT NULL,
    status              TEXT NOT NULL,
    queue_position      INTEGER,
    current_node_json   TEXT,
    context_json        TEXT NOT NULL,
    checkpoint_json     TEXT,
    output_json         TEXT,
    error_json          TEXT,
    terminal_reason     TEXT,
    total_tokens        INTEGER NOT NULL DEFAULT 0,
    total_cost          REAL,
    revision            INTEGER NOT NULL DEFAULT 0,
    queued_at           INTEGER NOT NULL,
    started_at          INTEGER,
    updated_at          INTEGER NOT NULL,
    ended_at            INTEGER,
    CHECK (status IN (
        'queued', 'starting', 'running', 'waiting_input',
        'stopping', 'paused', 'completed', 'failed', 'cancelled'
    ))
);

CREATE INDEX idx_workflow_runs_status_queue
ON workflow_runs(status, queued_at);

CREATE INDEX idx_workflow_runs_repository_updated
ON workflow_runs(repository_id, updated_at DESC);

CREATE TABLE workflow_events (
    run_id          TEXT NOT NULL,
    sequence        INTEGER NOT NULL,
    timestamp       INTEGER NOT NULL,
    event_type      TEXT NOT NULL,
    node_address    TEXT,
    payload_json    TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE TABLE workflow_script_trust (
    repository_id   TEXT NOT NULL,
    workflow_path   TEXT NOT NULL,
    definition_hash TEXT NOT NULL,
    trusted_at      INTEGER NOT NULL,
    PRIMARY KEY (repository_id, workflow_path, definition_hash)
);
```

Store repository/worktree names and paths as launch-time snapshots so history
remains understandable if a repository is later removed from DevTrees.

### Event transaction

Every state transition uses one transaction:

1. read and compare expected run revision;
2. allocate `MAX(sequence) + 1` for the run;
3. insert the event;
4. update materialized run state and increment revision;
5. commit;
6. emit the Tauri event.

The implementation may keep the next sequence in memory for active runs, but
the database remains authoritative after restart.

### Startup recovery

At app startup:

- restore `queued` runs to the scheduler;
- retain `paused` runs unchanged;
- convert `starting`, `running`, `waiting_input`, and `stopping` to `paused`
  when their checkpoint is valid;
- convert them to `failed` with `recovery-unavailable` when no safe checkpoint
  exists;
- never restore an in-memory interaction without its persisted request;
- never infer that an ACP session is alive only from a database row.

### Retention

After a run becomes terminal and at app startup:

1. sort terminal runs by `ended_at DESC`;
2. retain the newest 50;
3. delete older run rows in bounded batches;
4. rely on foreign-key cascade for their events;
5. never delete queued, active, stopping, or paused runs.

## Event contract

```ts
export type WorkflowEvent = {
  runId: string
  sequence: number
  timestamp: number
  type: WorkflowEventType
  nodeAddress?: WorkflowNodeAddress
  data: Record<string, unknown>
  runRevision: number
}
```

Required events:

| Type                      | Required data                                           |
| ------------------------- | ------------------------------------------------------- |
| `run_queued`              | queue position                                          |
| `workflow_started`        | metadata, entry point, static topology, definition hash |
| `node_queued`             | node type                                               |
| `node_started`            | node type, iteration                                    |
| `node_output`             | output, truncation metadata                             |
| `node_completed`          | elapsed, usage                                          |
| `node_failed`             | error code, message, recoverable                        |
| `route_taken`             | from, to, condition index                               |
| `parallel_started`        | group, members, failure mode                            |
| `parallel_completed`      | success/failure counts                                  |
| `for_each_started`        | group, item count, effective concurrency                |
| `for_each_item_started`   | group, key, index                                       |
| `for_each_item_completed` | group, key, index                                       |
| `gate_presented`          | request ID, rendered prompt, options                    |
| `gate_resolved`           | request ID, selected value                              |
| `questions_presented`     | request ID, question index                              |
| `question_answered`       | request ID, question ID, outcome                        |
| `subworkflow_started`     | child path, child workflow name                         |
| `subworkflow_completed`   | child output                                            |
| `checkpoint_saved`        | checkpoint version, reason                              |
| `run_stop_requested`      | requesting action                                       |
| `run_paused`              | reason                                                  |
| `run_resumed`             | prior revision                                          |
| `workflow_completed`      | output, explicit flag, reason                           |
| `workflow_failed`         | error, explicit flag, checkpoint availability           |
| `workflow_cancelled`      | reason                                                  |

### Payload limits

- Maximum serialized payload per event: 2 MiB.
- Large text fields are truncated with original byte count and
  `truncated: true`.
- Full ACP transcript history remains in the existing transcript store; the
  workflow event stores only the node result needed for replay.
- Environment values and credential-like launch configuration are never
  included.

## Backend components

```text
src-tauri/src/workflows/
  mod.rs
  schema.rs
  loader.rs
  validator.rs
  catalog.rs
  types.rs
  commands.rs
  events.rs
  store.rs
  manager.rs
  scheduler.rs
  checkpoint.rs
  templates.rs
  routing.rs
  engine/
    mod.rs
    context.rs
    agent.rs
    gate.rs
    questions.rs
    script.rs
    set_step.rs
    wait.rs
    terminate.rs
    parallel.rs
    for_each.rs
    subworkflow.rs
```

Responsibilities:

- `catalog`: repository scans and cached compiled definitions;
- `store`: SQLite queries and transactions;
- `manager`: active run controllers and public orchestration operations;
- `scheduler`: global FIFO and permits;
- `engine`: one run state machine;
- executors: side effects for one step kind;
- `events`: event construction, persistence, and Tauri emission;
- `commands`: narrow transport wrappers around manager/catalog operations.

Do not hold a `std::sync::Mutex` guard across `.await`.

## ACP integration

The existing `copilot_acp_sessions` module must expose an internal service
boundary. Tauri commands and workflow execution call the same service methods.

Suggested trait for deterministic tests:

```rust
#[async_trait]
trait WorkflowAgentRuntime: Send + Sync {
    async fn start(&self, request: AgentStartRequest) -> AppResult<AgentHandle>;
    async fn submit(&self, handle: &AgentHandle, prompt: Vec<Value>)
        -> AppResult<SubmissionHandle>;
    async fn await_result(&self, submission: &SubmissionHandle)
        -> AppResult<AgentTurnResult>;
    async fn cancel(&self, handle: &AgentHandle) -> AppResult<()>;
    async fn end(&self, handle: &AgentHandle) -> AppResult<()>;
}
```

Implementation requirements:

- preserve all existing session UI and persistence behavior;
- do not route workflow prompts through renderer callbacks;
- expose completion notification rather than polling renderer state;
- return the result associated with the workflow submission ID;
- retain generation checks so stale actions cannot affect a replacement
  process;
- include workflow ownership metadata in the session;
- allow normal Sessions-page navigation to the underlying session;
- show the workflow and node link in session metadata.

## Tauri API

### Catalog

```ts
workflows.listCatalog(repositoryId?: string): Promise<WorkflowCatalogItem[]>
workflows.refreshCatalog(repositoryId?: string): Promise<WorkflowCatalogItem[]>
workflows.getDefinition(repositoryId: string, relativePath: string):
  Promise<WorkflowDefinitionResult>
```

### Runs

```ts
workflows.listRuns(filter?: WorkflowRunFilter): Promise<WorkflowRunSummary[]>
workflows.getRun(runId: string): Promise<WorkflowRunSnapshotResult>
workflows.getEvents(runId: string, afterSequence?: number, limit?: number):
  Promise<WorkflowEventPageResult>
workflows.launch(request: LaunchWorkflowRequest): Promise<LaunchWorkflowResult>
```

### Controls

```ts
workflows.stop(runId: string, expectedRevision: number): Promise<WorkflowControlResult>
workflows.kill(runId: string, expectedRevision: number): Promise<WorkflowControlResult>
workflows.resume(runId: string, expectedRevision: number): Promise<WorkflowControlResult>
workflows.deleteRun(runId: string): Promise<DeleteWorkflowRunResult>
```

Deleting is allowed only for terminal runs.

### Interaction

```ts
workflows.answerGate(request: AnswerWorkflowGateRequest):
  Promise<WorkflowInteractionResult>
workflows.answerQuestion(request: AnswerWorkflowQuestionRequest):
  Promise<WorkflowInteractionResult>
```

Both requests include run ID, request ID, and expected revision.

### Trust

```ts
workflows.getScriptTrust(repositoryId: string, relativePath: string, hash: string):
  Promise<WorkflowTrustState>
workflows.grantScriptTrust(request: GrantWorkflowTrustRequest):
  Promise<WorkflowTrustResult>
workflows.revokeScriptTrust(repositoryId: string, relativePath: string):
  Promise<WorkflowTrustResult>
```

### Events

```ts
workflows.onUpdate(callback: (event: WorkflowEvent) => void): Promise<() => void>
```

The renderer loads a snapshot before subscribing, subscribes, then fetches
events after its last sequence to close the snapshot/subscription race.

### Error codes

Expected result unions use:

- `not-found`
- `invalid-definition`
- `invalid-input`
- `invalid-state`
- `stale-revision`
- `trust-required`
- `worktree-missing`
- `definition-changed`
- `concurrency-unavailable`
- `interaction-stale`
- `checkpoint-unavailable`
- `unknown`

Unexpected database, serialization, or process errors reject and are converted
through the existing `result()` bridge.

## Renderer architecture

```text
src/renderer/src/
  pages/workflows.tsx
  contexts/workflows-context.tsx
  components/workflows/
    workflow-catalog.tsx
    workflow-run-list.tsx
    workflow-launch-panel.tsx
    workflow-graph.tsx
    workflow-node.tsx
    workflow-edge.tsx
    workflow-detail-panel.tsx
    workflow-attention-panel.tsx
    workflow-event-list.tsx
    workflow-replay-controls.tsx
    workflow-script-trust.tsx
    graph-layout.ts
    event-reducer.ts
```

Add `workflows` to `AppView`, the activity rail, `App.tsx` page routing, and
header/status-bar context.

### State separation

Keep these independent:

- catalog data and validation state;
- run-list summaries;
- selected run;
- selected node;
- live run snapshot and last sequence;
- graph expansion/drill-down;
- launch draft;
- pending interaction drafts;
- replay cursor and playback state.

A pure event reducer must serve both live updates and history replay.

### Event reconciliation

When an incoming event sequence is not exactly `lastSequence + 1`:

1. stop applying events;
2. fetch the latest run snapshot and event cursor;
3. replace local derived state;
4. resume subscription handling.

Do not guess across gaps.

## Workflow cockpit UX

### Information architecture

Use a three-pane task surface:

```text
catalog/runs | graph | selected node/run detail
```

- Left pane width: compact and resizable within practical minimum/maximum.
- Center graph receives the largest area.
- Right detail pane may collapse, but node selection should reopen it.
- On narrower windows, the right pane becomes a sheet; the graph remains the
  primary surface.

### Left pane

Two compact sections:

1. Definitions for the selected repository.
2. Active, queued, paused, and recent runs.

Each run row shows:

- workflow name;
- selected worktree label;
- status;
- current node;
- elapsed time;
- attention indicator;
- queue position where applicable.

Invalid definitions remain selectable and open diagnostics instead of launch
controls.

### Header

- Repository selector when more than one repository is registered.
- Selected definition/run title.
- Worktree selector for launch.
- Refresh catalog.
- Launch, Stop, Kill, or Resume according to state.
- No destructive control is the default action.

### Graph

Use `@xyflow/react` and `@dagrejs/dagre`.

Node visual requirements:

- approximately 200x56 collapsed size;
- type icon, name, compact type/status metadata;
- selected state via border/background, not scale;
- visible focus ring;
- distinct waiting-input affordance;
- failure uses destructive color;
- completed/running/queued remain distinguishable without color alone;
- no nested card styling inside nodes.

Edge requirements:

- default possible route: neutral hairline;
- active transition: emphasized but non-decorative;
- taken route: persistent stronger line;
- failed transition: destructive;
- condition label available on selection/tooltip rather than always cluttering
  the graph;
- no edge animation under reduced motion.

Camera behavior:

- initial fit once;
- status-only events do not relayout;
- expanding a child graph anchors the viewport around the expanded container;
- Fit button is always available;
- user pan/zoom is not reset by incoming events.

Nested workflows:

- collapsed workflow node displays child workflow name;
- expand inline for bounded detail;
- drill-in opens a clean child graph with breadcrumb navigation;
- for-each group expansion first shows item pills; an item may then reveal its
  child graph.

### Detail pane

Depending on selection, show:

- workflow metadata and inputs;
- node definition;
- rendered prompt;
- output/result;
- script command, args, stdout, stderr, and exit code;
- gate prompt and decisions;
- questions and answers;
- error details and recoverability;
- route condition and chosen target;
- ACP session link;
- timing and usage.

Large Markdown output uses the existing sanitized Markdown renderer.

### Attention requests

Workflow-level gates/questions use a compact inline request region in the
detail pane, not a modal. Selecting an attention badge:

1. selects the run;
2. selects the waiting node;
3. opens the detail pane;
4. moves focus to the request heading only after explicit navigation.

Approval must never receive automatic focus. Rejection, decline, cancel, and
revision options appear before approval actions where semantics allow.

### Launch

Launch is an inline panel:

1. select definition;
2. select worktree;
3. complete generated input fields;
4. review script trust if required;
5. launch.

If all four run permits are occupied, the primary action says `Queue run`.
The app does not fail a valid launch merely because capacity is occupied.

### Script trust

The trust surface shows:

- repository-relative workflow path;
- full SHA-256 hash;
- every reachable script program and rendered-independent argument template;
- explanation that editing the file invalidates trust;
- `Cancel` before `Trust and run`.

Trust does not imply approval of ACP permission prompts.

### Empty states

- No repository: direct the user to add one.
- No workflow directory: explain `.github/dt-workflows`.
- Empty directory: show the expected extensions and link/open the folder.
- Invalid workflows only: show diagnostics and external editor action.
- No runs: keep the definition catalog and launch affordance visible.
- No node selected: show run summary, not an empty card.

## History and replay

Completed, failed, and cancelled runs remain selectable until retention prunes
them.

Static history must ship before animated replay:

- final graph status;
- taken routes;
- node outputs and errors;
- event list;
- run inputs and output.

Replay later adds:

- event cursor;
- previous/next event;
- play/pause;
- 0.5x, 1x, 2x, and 4x;
- jump to node event;
- timestamp and sequence display.

Replay folds events into an isolated renderer state. It never issues backend
controls or mutates the stored run.

## Security

### Repository trust boundary

Workflow YAML is repository-controlled executable configuration. Merely
opening a repository may parse definitions but must not execute them.

### Script execution

- Require trust for the exact workflow hash before launch.
- Do not invoke a shell implicitly.
- Pass command arguments separately.
- Keep working directories inside the selected worktree.
- Reject NUL characters and invalid environment keys.
- Do not expose environment values in events or UI.
- Kill workflow-owned process trees only.
- Revoke all previous trust for a path through the UI.

### Template safety

- Do not expose arbitrary Rust functions or filesystem access to templates.
- Bound rendering time and output size.
- Reject unsupported syntax at validation.
- Treat model and script output as untrusted input.

### Markdown

Render workflow prompts and outputs through the existing sanitized Markdown
pipeline. Do not allow workflow content to inject executable HTML or Tauri
commands.

### Path safety

- Canonicalize repository, worktree, workflow, nested workflow, and rendered
  working-directory paths.
- Verify containment after canonicalization.
- Reject nested workflow paths outside the repository.
- Reject working directories outside the selected worktree.

## Reliability

- Persist run creation before returning launch success.
- Persist lifecycle events before notifying the renderer.
- Use revision compare-and-swap for controls and interactions.
- Use stable submission IDs so a retried command cannot enqueue a duplicate
  ACP prompt silently.
- Represent uncertain ACP delivery as uncertain; never mark it completed.
- Bound all child-process output and event payloads.
- Do not allow a renderer crash or closed window to stop backend workflow
  execution.
- App shutdown attempts graceful workflow Stop before ACP manager shutdown,
  then records unresolved active runs as recoverable/failed during next startup.

## Performance targets

- Catalog scan of 100 workflow files: under 250 ms on a typical local SSD
  after repository enumeration.
- Opening Workflows with 50 retained runs: first useful content under 500 ms
  after renderer mount.
- Applying one status event: no full catalog reload and no graph relayout.
- Run list update to visible UI: under 200 ms after backend event commit.
- Graph remains interactive with 200 visible nodes.
- Event page size defaults to 200 and is capped at 1,000.
- SQLite queries use indexed run status/repository/time paths.

## Accessibility

- All graph nodes are keyboard focusable and expose type, name, and status.
- Arrow keys move to connected nodes; Enter selects; Escape returns focus to
  the graph.
- Controls have text alternatives and visible focus rings.
- Status is never conveyed by color alone.
- Body and placeholder text meet WCAG 2.1 AA.
- Motion obeys `prefers-reduced-motion`.
- Gate approval is not auto-focused.
- Error summaries link to individual invalid input or diagnostic fields.

## Default conformance workflow

`.github/dt-workflows/default.yml` is the first end-to-end acceptance fixture.
It covers:

- repository discovery;
- one defaulted string input;
- `set`;
- Copilot ACP `agent`;
- `human_gate`;
- option-directed success and failure routes;
- explicit `terminate`;
- final output rendering;
- live graph status;
- attention handling;
- terminal history.

The definition is intentionally read-only.

## Test strategy

### Rust schema and validation

- valid minimal workflow;
- invalid YAML with line/column;
- unsupported provider and fields;
- duplicate names across steps/groups;
- unknown entry point and route target;
- invalid input defaults;
- route ordering and unreachable route warning;
- template compilation and missing value behavior;
- nested workflow containment, cycle, and depth;
- workflow hash changes when bytes change.

### Engine

- linear execution;
- first matching conditional route;
- implicit `$end`;
- max iteration and timeout;
- each local step success/failure/cancellation;
- gate stale response;
- question back/skip/abort;
- script trust and trust invalidation;
- wait checkpoint/resume;
- explicit termination;
- deterministic parallel aggregation;
- each failure mode;
- for-each key/order/concurrency;
- nested workflow success/failure;
- definition-changed resume rejection.

### Scheduler and persistence

- four runs active and fifth queued;
- FIFO across restart;
- permit release on pause and terminal state;
- stop and kill races;
- revision conflict;
- append-only event ordering;
- snapshot/event transaction atomicity;
- startup recovery;
- retention keeps exactly newest 50 terminal runs;
- active and paused runs are never pruned.

### ACP boundary

Use a fake `WorkflowAgentRuntime` in deterministic tests:

- prompt submitted once;
- output associated with correct submission;
- usage captured;
- permission interaction propagated;
- stop cancels turn;
- kill ends owned session;
- unrelated session remains active;
- delivery-unknown does not become success;
- resumed session working directory mismatch starts safely or errors.

### Renderer

- catalog empty/invalid/valid states;
- generated input fields;
- script trust ordering and focus;
- event reducer for every event;
- sequence gap recovery;
- no graph relayout on status-only event;
- nested node ID uniqueness;
- route styling;
- attention navigation;
- controls enabled by state;
- final history;
- replay reducer;
- keyboard graph navigation;
- reduced motion.

### End-to-end fixtures

Add fixtures under `.github/dt-workflows/fixtures` or a test-only fixture
directory for:

- linear workflow;
- branching loop;
- static parallel;
- dynamic for-each;
- questions;
- script/set/wait;
- nested workflows;
- stop/resume;
- app restart;
- scheduler saturation.

Do not allow test-only fixtures to appear in the production catalog unless
they are deliberately named and documented examples.

## Implementation plan

### Phase 1: Contracts and static definitions

Deliverables:

1. Add shared TypeScript workflow types and channel constants.
2. Add Rust schema types and YAML dependency.
3. Implement parsing, normalization, hashing, diagnostics, and validation.
4. Implement repository catalog scanning and Tauri catalog commands.
5. Add database schema for runs, events, and trust.
6. Add Workflows navigation and catalog UI.
7. Add React Flow/Dagre dependencies and static topology graph.
8. Render `.github/dt-workflows/default.yml`.

Exit criteria:

- The default workflow appears under its repository.
- Invalid files appear with precise diagnostics.
- Static nodes and possible routes render correctly.
- No execution command is exposed yet.

### Phase 2: Event store, queue, and local steps

Deliverables:

1. Implement run/event repository and transactional revision handling.
2. Implement durable FIFO scheduler with four permits.
3. Implement run and node state machines.
4. Implement context, templates, routing, limits, and checkpoints.
5. Implement set, wait, terminate, human gate, questions, and script.
6. Implement hash trust.
7. Add live event subscription, run list, controls, attention panel, and
   static history.

Exit criteria:

- A workflow containing only local/human steps runs end to end.
- Fifth concurrent run queues and later starts.
- Stop produces a resumable checkpoint.
- Kill is terminal.
- Restart recovers queued and paused runs.

### Phase 3: Copilot ACP agents

Deliverables:

1. Extract an internal ACP service boundary.
2. Implement the production `WorkflowAgentRuntime`.
3. Add workflow ownership metadata to sessions.
4. Implement agent prompt, output, usage, interaction, cancellation, and
   resume handling.
5. Cross-link Workflows and Sessions.
6. Run the default conformance workflow end to end.

Exit criteria:

- The default workflow reaches its gate with real ACP output.
- Accept completes successfully; Reject produces explicit failure.
- Stop during an ACP turn pauses safely.
- Kill ends only the workflow-owned session.

### Phase 4: Parallelism and composition

Deliverables:

1. Implement static parallel groups and failure modes.
2. Implement dynamic for-each and stable item identity.
3. Enforce the five-agent run semaphore.
4. Implement nested workflow loading, contexts, and depth.
5. Add graph group containers, item pills, inline expansion, and breadcrumbs.
6. Add partial-fan-out checkpoint and resume tests.

Exit criteria:

- Parallel and for-each outputs are deterministic.
- No run exceeds five simultaneous ACP agents.
- Nested workflow node IDs and events cannot collide.
- Partial fan-out resumes without rerunning confirmed completed items.

### Phase 5: Replay and hardening

Deliverables:

1. Add animated replay controls over the pure reducer.
2. Implement retention pruning and corruption recovery.
3. Add payload truncation and large-output UI.
4. Complete keyboard and screen-reader behavior.
5. Profile catalog, event, and graph performance.
6. Document supported and rejected Conductor fields.
7. Complete all end-to-end fixtures and regression suites.

Exit criteria:

- Fifty-run retention is deterministic.
- Replay reaches the same final state as the saved snapshot.
- Performance targets are met.
- Existing task/session behavior remains unchanged.

## Suggested dependency changes

Rust:

- YAML deserialization library compatible with Serde.
- Order-preserving map support where not already available.
- SHA-256 hashing.
- A constrained Jinja-compatible template engine.
- Cancellation token utility if the existing Tokio primitives are
  insufficient.

Renderer:

- `@xyflow/react`
- `@dagrejs/dagre`

Prefer the smallest dependency set that satisfies the contract. Do not add a
second state library unless the event reducer proves React Context unsuitable.

## File-level implementation map

| Area                   | Files                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Shared contract        | `src/shared/workflow.ts`                                                                                                   |
| Database               | `src-tauri/src/db.rs`                                                                                                      |
| Backend registration   | `src-tauri/src/lib.rs`                                                                                                     |
| Workflow backend       | `src-tauri/src/workflows/**`                                                                                               |
| ACP reuse              | `src-tauri/src/copilot_acp_sessions.rs`, `src-tauri/src/copilot_acp_sessions/**`                                           |
| API bridge             | `src/renderer/src/lib/api.ts`, `src/renderer/src/env.d.ts` if required                                                     |
| Navigation             | `src/renderer/src/App.tsx`, `src/renderer/src/components/activity-rail.tsx`, `src/renderer/src/components/app-sidebar.tsx` |
| Workflow page          | `src/renderer/src/pages/workflows.tsx`                                                                                     |
| Workflow state         | `src/renderer/src/contexts/workflows-context.tsx`                                                                          |
| Workflow UI            | `src/renderer/src/components/workflows/**`                                                                                 |
| Styling                | existing Tailwind tokens and `src/renderer/src/assets/main.css` only for graph-specific global selectors                   |
| Conformance definition | `.github/dt-workflows/default.yml`                                                                                         |

## Acceptance criteria

The implementation is complete when:

1. DevTrees discovers the default workflow from a registered repository.
2. The static graph matches the YAML topology.
3. A user can select a worktree, accept default inputs, and launch it.
4. The run starts immediately or enters the durable queue.
5. The set node completes without ACP.
6. The agent node runs in the selected worktree through ACP.
7. ACP permission requests remain explicit and visible.
8. The agent output appears in the graph detail pane.
9. The human gate parks the run and surfaces attention.
10. Accept follows the success edge and completes.
11. Reject follows the failure edge and fails explicitly.
12. History reproduces the final nodes, selected route, output, and reason.
13. Stop during agent execution creates a paused resumable run.
14. Resume continues only when the definition hash is unchanged.
15. Kill cancels the run without affecting unrelated sessions.
16. Four runs execute while a fifth remains visibly queued.
17. Script workflows require current-hash trust.
18. Nested and for-each nodes remain uniquely addressable.
19. Renderer event gaps trigger snapshot reconciliation.
20. Existing DevTrees repository, task, session, review, and analytics flows
    continue to work.

## Deferred compatibility backlog

These require separate specification updates:

- structured agent output schemas and parse recovery;
- per-step retry/backoff policies;
- alternative context modes;
- dynamic question sources;
- nested for-each groups;
- provider-specific model and reasoning settings beyond existing ACP launch
  configuration;
- MCP server definitions in workflow YAML;
- registry references and remote workflow packages;
- timed or event-triggered workflow launch;
- visual authoring and YAML round-trip.
