// The native panel stays open while the user works on the job page.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'roletrack-close-current-tab' || sender.tab?.id == null) return;
  chrome.tabs.remove(sender.tab.id).catch((error) => {
    console.warn('[RoleTrack] Could not close the application tab.', error);
  });
});
