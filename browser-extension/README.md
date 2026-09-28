# SWE Factory browser extension

The Chrome extension sends the active browser page to the installed SWE Factory desktop app. It
can create a code-review task from any HTTP(S) page or open supported pull requests directly in
SWE Factory's manual review workspace.

## Install in Chrome

1. Install and launch a packaged SWE Factory build once so Windows registers the `swefactory://` protocol.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this `browser-extension` folder.
5. Pin SWE Factory from the Extensions menu.

The extension works with normal HTTP and HTTPS pages. Chrome-protected pages, including `chrome://` pages and the Chrome Web Store, do not expose their page URL to extensions.

## Browser actions

1. Open the pull request, issue, or source page to review.
2. Open the SWE Factory extension.
3. Choose an action:
   - **Start code review** creates a prefilled code-review task from any HTTP(S) page.
   - **Review in app** appears on supported GitHub and Azure DevOps pull-request pages and opens
     the existing manual diff, comments, and voting workspace directly.
4. Confirm Chrome's external-app prompt if it appears.

**Review in app** supports:

- `https://github.com/<owner>/<repository>/pull/<id>`
- `https://dev.azure.com/<organization>/<project>/_git/<repository>/pullrequest/<id>`
- `https://<organization>.visualstudio.com/<project>/_git/<repository>/pullrequest/<id>`

The matching repository must already be configured in SWE Factory. Matching uses the repository's
origin remote identity, not its local folder name. SWE Factory reports an error instead of guessing
when no repository matches or more than one configured entry points at the same remote.

For **Start code review**, SWE Factory opens Tasks and displays an Add task dialog containing the
page context and the prompt assigned to browser code reviews. Confirm the repository and worktree
to create the task and start the code review.

No task or Copilot session starts until the task dialog is submitted. After submission, SWE Factory
starts the review directly in autopilot mode instead of opening a plan-mode task.

## Saved prompt

Open **Settings > Saved prompts** in SWE Factory to edit or create prompt templates. Assign one prompt with **Use for browser reviews**.

Browser-review templates support:

- `{{url}}` - complete page URL
- `{{pageTitle}}` - page title, or host when the title is unavailable
- `{{host}}` - page host

Prompt names can be changed safely because the browser-review assignment uses the prompt's internal ID. Assign another prompt before deleting the active browser-review prompt.

## Development testing

Desktop deep links are registered by an installed build. For local Windows development, run the Tauri app once with the deep-link plugin's development registration enabled or test against an installed development package, then open:

```text
swefactory://tasks/new?intent=code-review&url=https%3A%2F%2Fgithub.com%2Fowner%2Frepository%2Fpull%2F1&title=Example%20pull%20request
```

To open the same pull request directly in the manual review workspace:

```text
swefactory://reviews/pull-request?url=https%3A%2F%2Fgithub.com%2Fowner%2Frepository%2Fpull%2F1&title=Example%20pull%20request
```

The integration uses the operating-system protocol handler and Tauri events; it does not run a local HTTP or WebSocket service.
