// The native panel stays open while the user works on the job page.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
