# DevTrees browser extension

The Chrome extension sends the active browser page to the installed DevTrees desktop app and opens a prefilled code-review task.

## Install in Chrome

1. Install and launch a packaged DevTrees build once so Windows registers the `devtrees://` protocol.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this `browser-extension` folder.
5. Pin DevTrees from the Extensions menu.

The extension works with normal HTTP and HTTPS pages. Chrome-protected pages, including `chrome://` pages and the Chrome Web Store, do not expose their page URL to extensions.

## Start a code review

1. Open the pull request, issue, or source page to review.
2. Open the DevTrees extension and choose **Start code review**.
3. Confirm Chrome's external-app prompt if it appears.
4. DevTrees opens Tasks and displays an Add task dialog containing the page context and the prompt assigned to browser code reviews.
5. Confirm the repository and worktree before creating the task.

No task or Copilot session starts until the task dialog is submitted.

## Saved prompt

Open **Settings > Saved prompts** in DevTrees to edit or create prompt templates. Assign one prompt with **Use for browser reviews**.

Browser-review templates support:

- `{{url}}` - complete page URL
- `{{pageTitle}}` - page title, or host when the title is unavailable
- `{{host}}` - page host

Prompt names can be changed safely because the browser-review assignment uses the prompt's internal ID. Assign another prompt before deleting the active browser-review prompt.

## Development testing

Desktop deep links are registered by an installed build. For local Windows development, run the Tauri app once with the deep-link plugin's development registration enabled or test against an installed development package, then open:

```text
devtrees://tasks/new?intent=code-review&url=https%3A%2F%2Fgithub.com%2Fowner%2Frepository%2Fpull%2F1&title=Example%20pull%20request
```

The integration uses the operating-system protocol handler and Tauri events; it does not run a local HTTP or WebSocket service.
