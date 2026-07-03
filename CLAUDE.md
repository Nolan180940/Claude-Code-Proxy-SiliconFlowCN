# Terminal-First Rules (MANDATORY)

## 1. Browser URLs — use terminal, NEVER use CUA for this

When asked to open a website, ALWAYS use Bash/PowerShell commands. NEVER use cua-computer-use tools for browser navigation.

- `start msedge "URL"` — open in Edge
- `start chrome "URL"` — open in Chrome  
- `start "" "URL"` — open in default browser
- `start "" "https://www.google.com/search?q=QUERY"` — search Google

## 2. Files and system info — use terminal

- `Get-ChildItem "path"` or `ls path` — list files
- `curl "URL"` — fetch web content
- `curl "wttr.in/City?format=3"` — weather

## 3. CUA is for GUI-only desktop actions

Only use cua-computer-use for tasks that have NO terminal equivalent:
- clicking a button in a native desktop app
- reading screen content that's not text-based
- single screenshots for visual analysis (NOT looped for browser automation)

## 4. NEVER do this

- ❌ cua-computer-use + click/type/scroll loops to automate a browser
- ❌ cua-computer-use get_window_state or get_accessibility_tree for browser windows
- ❌ Multiple cua-computer-use calls to open a URL
