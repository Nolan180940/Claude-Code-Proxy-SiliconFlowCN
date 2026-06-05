@echo off
REM ========================================
REM  claude-cn - Launch Claude Code via local proxy
REM  Usage: First run start-proxy.bat, then type 'claude-cn' in any terminal
REM  Install: Copy this file to a folder in your PATH (e.g. npm-global)
REM ========================================
set ANTHROPIC_BASE_URL=http://127.0.0.1:8787
set ANTHROPIC_API_KEY=sk-siliconflow-proxy
claude --bare