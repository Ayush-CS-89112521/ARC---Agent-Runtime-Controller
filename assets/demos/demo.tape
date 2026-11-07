# ARC Hero GIF - Storyboard to VHS
# Duration: 15 seconds
# Resolution: 1280x720
# Frame Rate: 30 FPS

Output "demo.gif"
Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Theme "Dracula"
Set Width 1280
Set Height 720
Set TypingSpeed 75ms
Set PlaybackSpeed 1
Set CursorBlink false

# ============================================================================
# SCENE 1: TITLE & PROBLEM (0-2s)
# ============================================================================

# Clear and show title
Clear
Type "╔════════════════════════════════════════════════════════════════════════════╗"
Sleep 100ms
Type ""
Sleep 100ms
Type "║  Agent Runtime Controller (ARC)                                          ║"
Sleep 200ms
Type ""
Sleep 100ms
Type "║  Type-safe, defense-in-depth workflow automation                          ║"
Sleep 200ms
Type ""
Sleep 100ms
Type "║  114/114 tests • 0 TypeScript errors • 8-layer safety guarantee           ║"
Sleep 200ms
Type ""
Sleep 100ms
Type "╚════════════════════════════════════════════════════════════════════════════╝"
Sleep 1200ms

# ============================================================================
# SCENE 2: ARC INIT COMMAND (2-4s)
# ============================================================================

Clear
Type "# Step 1: Initialize a secure workflow project"
Sleep 200ms
Enter
Enter
Type "$ arc init demo-project"
Sleep 150ms
Enter
Sleep 300ms

Type "✓ Creating project structure..."
Sleep 100ms
Enter

Sleep 200ms
Type "✓ Scaffolding workflows/workflow.yaml (74 lines, 8 layers documented)"
Sleep 100ms
Enter

Sleep 200ms
Type "✓ Creating .env.example (credentials template)"
Sleep 100ms
Enter

Sleep 200ms
Type "✓ Generating README.md (quick-start guide)"
Sleep 100ms
Enter

Sleep 200ms
Type "✓ Setting up outputs/ directory"
Sleep 100ms
Enter

Sleep 300ms
Type ""
Sleep 100ms
Enter
Type "cd demo-project && cat workflows/workflow.yaml"
Sleep 150ms
Enter
Sleep 400ms

# ============================================================================
# SCENE 3: WORKFLOW EXECUTION WITH RESOURCE WATCHDOG (4-9s)
# ============================================================================

Clear
Type "# Step 2: Execute workflow with 8-layer safety verification"
Sleep 200ms
Enter
Enter
Type "$ arc workflows/workflow.yaml"
Sleep 150ms
Enter
Sleep 300ms

Type "▸ Executing: Code Review Assistant Workflow"
Sleep 100ms
Enter
Sleep 200ms

Type "  Step 1/3: analyze_code"
Sleep 100ms
Enter
Sleep 150ms

Type "    ✓ Layer 1: Schema validated (Zod)"
Sleep 50ms
Enter
Sleep 100ms

Type "    ✓ Layer 2: Dependencies resolved (topological sort)"
Sleep 50ms
Enter
Sleep 100ms

Type "    ✓ Layer 3: Conditions evaluated (sandbox)"
Sleep 50ms
Enter
Sleep 100ms

Type "    ✓ Layer 4: Resources monitored (exponential moving average)"
Sleep 50ms
Enter
Sleep 100ms

Type "    ✓ Layer 5: Patterns checked (15+ dangerous patterns scanned)"
Sleep 50ms
Enter
Sleep 100ms

Type "    ✓ Layer 6: Human gate pending..."
Sleep 100ms
Enter
Sleep 300ms

Type ""
Sleep 100ms
Enter
Type "⚠️  VIOLATION DETECTED: unsafe command 'curl | bash'"
Sleep 150ms
Enter
Sleep 100ms

Type "  Confidence: 95%  Severity: BLOCK"
Sleep 150ms
Enter
Sleep 200ms

# ============================================================================
# SCENE 4: INTERACTIVE APPROVAL GATE (9-14s)
# ============================================================================

Type ""
Sleep 100ms
Enter
Type "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Sleep 100ms
Enter
Type "  Safety Violation: curl piped to bash (remote code execution risk)"
Sleep 100ms
Enter
Type "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Sleep 100ms
Enter
Enter

Type "  Remediation:"
Sleep 50ms
Enter
Type "  1. Review source URL for authenticity"
Sleep 100ms
Enter
Type "  2. Download script locally and audit contents"
Sleep 100ms
Enter
Type "  3. Use environment-specific install methods"
Sleep 100ms
Enter
Enter

Type "  ▸ Approve (a)  ▸ Deny (d)  ▸ Inspect (i)"
Sleep 200ms
Enter
Type "  Your decision (a/d/i): "
Sleep 100ms
Type "d"
Sleep 100ms
Enter

Sleep 400ms

Type ""
Sleep 100ms
Enter
Type "✓ Safety violation denied. Execution paused."
Sleep 150ms
Enter
Sleep 300ms

# ============================================================================
# SCENE 5: SUMMARY & CALL TO ACTION (14-15s)
# ============================================================================

Type ""
Sleep 100ms
Enter
Type "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Sleep 100ms
Enter
Type "  ✅ Safety Verified: 8/8 layers active, 114/114 tests passing"
Sleep 100ms
Enter
Type "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Sleep 100ms
Enter
Sleep 500ms

Type ""
Sleep 100ms
Enter
Type "Ready for production. Try it:"
Sleep 100ms
Enter
Type "  npm ci"
Sleep 100ms
Enter
Sleep 800ms
