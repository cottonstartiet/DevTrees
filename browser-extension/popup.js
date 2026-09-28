/* global chrome, document, URL, window */

const reviewButton = document.querySelector('#start-review')
const reviewInAppButton = document.querySelector('#review-in-app')
const pageTitle = document.querySelector('#page-title')
const pageHost = document.querySelector('#page-host')
const status = document.querySelector('#status')

let activePage = null

function isPullRequestPage(url) {
  const segments = url.pathname.split('/').filter(Boolean)

  if (
    url.hostname.toLowerCase() === 'github.com' &&
    segments.length >= 4 &&
    segments[2].toLowerCase() === 'pull'
  ) {
    return /^[1-9][0-9]{0,9}$/.test(segments[3])
  }

  const host = url.hostname.toLowerCase()
  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === '_git')
  const hasSupportedPrefix =
    (host === 'dev.azure.com' && (gitIndex === 1 || gitIndex === 2)) ||
    (/^([^.]+)\.visualstudio\.com$/.test(host) && gitIndex === 1)
  return (
    hasSupportedPrefix &&
    segments[gitIndex + 2]?.toLowerCase() === 'pullrequest' &&
    /^[1-9][0-9]{0,9}$/.test(segments[gitIndex + 3] || '')
  )
}

function setStatus(message, error = false) {
  status.textContent = message
  status.dataset.error = String(error)
}

async function loadActivePage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url) throw new Error('The current page URL is unavailable.')

    const url = new URL(tab.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Open a normal HTTP or HTTPS page to start a review.')
    }

    activePage = {
      url: url.toString(),
      title: (tab.title || '').trim()
    }
    pageTitle.textContent = activePage.title || url.host
    pageHost.textContent = url.host
    reviewButton.disabled = false
    if (isPullRequestPage(url)) {
      reviewInAppButton.hidden = false
      reviewInAppButton.disabled = false
    }
  } catch (error) {
    pageTitle.textContent = 'Page unavailable'
    pageHost.textContent = ''
    setStatus(error instanceof Error ? error.message : 'Could not read the current page.', true)
  }
}

function openDeepLink(button, deepLink, loadingLabel) {
  reviewButton.disabled = true
  reviewInAppButton.disabled = true
  button.textContent = loadingLabel
  setStatus('Chrome may ask you to confirm opening the desktop app.')
  window.location.assign(deepLink.toString())
}

reviewButton.addEventListener('click', () => {
  if (!activePage) return

  const deepLink = new URL('swefactory://tasks/new')
  deepLink.searchParams.set('intent', 'code-review')
  deepLink.searchParams.set('url', activePage.url)
  if (activePage.title) deepLink.searchParams.set('title', activePage.title)

  openDeepLink(reviewButton, deepLink, 'Opening SWE Factory...')
})

reviewInAppButton.addEventListener('click', () => {
  if (!activePage) return

  const deepLink = new URL('swefactory://reviews/pull-request')
  deepLink.searchParams.set('url', activePage.url)
  if (activePage.title) deepLink.searchParams.set('title', activePage.title)

  openDeepLink(reviewInAppButton, deepLink, 'Opening review...')
})

void loadActivePage()
