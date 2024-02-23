# Mobile Sync Status
## Status Bar
1. To show the status bar on mobile. Go to 'Settings > Appearance > CSS Snippets' and press 'Open snippets folder.
2. Create a new css file called 'mobile-status-bar.css'. This can have any name but must end in '.css'.
3. Right click and edit the file. Paste the following:

```
.is-mobile .app-container .status-bar {
	display: flex;
}
```

4. Go back to the settings and enable the snippet. All finished!

## Mobile Quick Acton
Alternatively you can use the mobile quick action feature. This allows you to swipe down from the top of the screen to check the sync status.
1. Go to 'Settings > Mobile > Configure mobile Quick Action' and press 'Configure'. 
2. Search for the 'Remotely Sync: Get sync status' command select it.
3. All done! Open a note and give it a try.