/* global chrome, document, URL, window */

const reviewButton = document.querySelector('#start-review')
const pageTitle = document.querySelector('#page-title')
const pageHost = document.querySelector('#page-host')
const status = document.querySelector('#status')

let activePage = null

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
  } catch (error) {
    pageTitle.textContent = 'Page unavailable'
    pageHost.textContent = ''
    setStatus(error instanceof Error ? error.message : 'Could not read the current page.', true)
  }
}

reviewButton.addEventListener('click', () => {
  if (!activePage) return

  reviewButton.disabled = true
  reviewButton.textContent = 'Opening DevTrees...'
  setStatus('Chrome may ask you to confirm opening the desktop app.')

  const deepLink = new URL('devtrees://tasks/new')
  deepLink.searchParams.set('intent', 'code-review')
  deepLink.searchParams.set('url', activePage.url)
  if (activePage.title) deepLink.searchParams.set('title', activePage.title)

  window.location.assign(deepLink.toString())
})

void loadActivePage()
