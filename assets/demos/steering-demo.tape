# Steering Demo - VHS Recording Script
# Demonstrates Phase 5 Human-in-the-Loop Steering Interface
# Scenario: Dangerous git push intercepted by steering interface, user corrects it
# Duration: 15 seconds
# Resolution: 1280×720 (16:9 aspect ratio)

Output steering-demo.gif

Set Theme Dracula
Set FontFamily "JetBrains Mono"
Set FontSize 18
Set Width 1280
Set Height 720
Set FrameRate 30
Set Timeout 30

# ============================================================================
# Scene 1: Initialization (0-2s)
# User runs the workflow with --step-mode flag
# ============================================================================

Type "arc deploy.yaml --step-mode"
Sleep 500ms
Enter
Sleep 1s

# Simulated output: Workflow starting
Type "🎯 Workflow 'deploy' initialized with --step-mode"
Enter
Type "📝 Parsing deploy.yaml..."
Enter
Sleep 500ms
Type "✅ Loaded 3 steps: checkout → build → deploy"
Enter
Sleep 1s

# ============================================================================
# Scene 2: Steering Interface Appears (2-6s)
# The agent proposes a dangerous command (git push origin main --force)
# The steering interface pauses execution and asks the user
# ============================================================================

Sleep 1s
Type ""
Enter
Type "═══════════════════════════════════════════════════════════════════════════"
Enter
Type "🎛️  STEERING INTERFACE - Step: deploy-to-main"
Enter
Type "═══════════════════════════════════════════════════════════════════════════"
Enter
Sleep 200ms
Type ""
Enter
Type "📋 Proposed Tool: git"
Enter
Type "📝 Arguments:"
Enter
Type "  push origin main --force"
Enter
Sleep 200ms
Type ""
Enter
Type "💭 Reasoning: Agent believes main branch needs force update for deployment"
Enter
Sleep 1s
Type ""
Enter
Type "⚠️  ⚠️  WARNING: Force push to main branch is dangerous! ⚠️  ⚠️"
Enter
Sleep 1s

# ============================================================================
# Scene 3: Menu Options Displayed (6-8s)
# Show the steering menu with 4 interactive options
# ============================================================================

Type ""
Enter
Type "Select action:"
Enter
Type "  ▶️  Run - Execute tool immediately"
Enter
Type "  ✏️  Edit - Modify arguments before running"
Enter
Type "  💬 Add Context - Inject feedback for next step"
Enter
Type "  ⏹️  Terminate - Stop workflow"
Enter
Sleep 500ms
Type ""
Enter
Type "? Select action: (Use arrow keys)"
Enter
Sleep 1s

# ============================================================================
# Scene 4: User Selects Edit (8-9s)
# User navigates to "Edit" option and confirms
# ============================================================================

Type "↓"
Sleep 200ms
Type "  ✏️  Edit - Modify arguments before running"
Enter
Sleep 500ms

# ============================================================================
# Scene 5: Edit Interface Opens (9-11s)
# Show the editor context with the original arguments
# User will edit the arguments
# ============================================================================

Type ""
Enter
Type "📝 Opening vim to edit arguments..."
Enter
Sleep 300ms
Type ""
Enter
Type "--- Arguments Editor (save and exit to continue) ---"
Enter
Type ""
Enter
Type "push origin main --force"
Enter
Sleep 500ms

# ============================================================================
# Scene 6: User Modifies Arguments (11-13s)
# Simulate backspacing the dangerous flags and typing the safe branch
# This is the critical intervention point
# ============================================================================

Type ""
Enter
Type "⌨️  Editing..."
Enter
Sleep 200ms
Type "Backspacing 'main --force'..."
Enter
Sleep 300ms
Type ""
Enter
Type "push origin dev"
Enter
Sleep 200ms
Type ""
Enter
Type "✅ Arguments updated."
Enter
Sleep 500ms

# ============================================================================
# Scene 7: Command Executes Safely (13-14s)
# Show the command executing with the corrected arguments
# ============================================================================

Type ""
Enter
Type "▶️  Executing: git push origin dev"
Enter
Sleep 300ms
Type ""
Enter
Type "   Enumerating objects: 12, done."
Enter
Type "   Counting objects: 100% (12/12), done."
Enter
Sleep 200ms
Type "   Writing objects: 100% (8/8), 2.3 KiB | 2.3 MiB/s, done."
Enter
Sleep 200ms
Type "   Total 8 (delta 4), reused 0 (delta 0)"
Enter
Type "   To github.com:myorg/myrepo.git"
Enter
Type "    * [new branch]      dev -> dev"
Enter
Sleep 500ms

# ============================================================================
# Scene 8: Audit Trail & Success Message (14-15s)
# Show the context injection audit log confirming human intervention
# Display success indicator
# ============================================================================

Type ""
Enter
Type "✅ Step 'deploy-to-main' completed safely"
Enter
Sleep 300ms
Type ""
Enter
Type "📊 Audit Trail:"
Enter
Type "   ✅ Context injected into step 'deploy-to-main' (type: parameter-adjustment)"
Enter
Type "   👤 User action: [E]dit - Modified branch from 'main' to 'dev'"
Enter
Type "   🛡️  Safety: Force push to main blocked by steering interface"
Enter
Sleep 500ms
Type ""
Enter
Type "📝 Training Data Recorded:"
Enter
Type "   Intervention Type: parameter-correction"
Enter
Type "   Difficulty Score: 8/10 (dangerous command detected)"
Enter
Type "   Tags: #git-safety #human-intervention #force-push-blocked"
Enter
Sleep 500ms

# ============================================================================
# Scene 9: TRAINING EXAMPLE CAPTURED (THE CLIMAX - 14.5-15s)
# This is the key moment: show the structured training example being logged
# This turns every human intervention into a fine-tuning dataset
# ============================================================================

Type ""
Enter
Sleep 200ms
Type "🎯 TRAINING EXAMPLE CAPTURED"
Enter
Sleep 200ms
Type "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Enter
Sleep 100ms
Type ""
Enter
Type "✅ audit.jsonl << EOF"
Enter
Sleep 100ms
Type "  {\"id\": \"steering-2026-02-06-1447\","
Enter
Type "   \"timestamp\": \"2026-02-06T14:47:32Z\","
Enter
Type "   \"workflow\": \"deploy-pipeline.yaml\","
Enter
Type "   \"suggested_command\": \"git push origin main --force\","
Enter
Type "   \"human_action\": \"EDIT\","
Enter
Type "   \"corrected_command\": \"git push origin dev\","
Enter
Type "   \"human_reasoning\": \"Force push to main is dangerous; use dev branch instead\","
Enter
Type "   \"confidence_before\": 0.89,"
Enter
Type "   \"confidence_after\": 0.12,"
Enter
Type "   \"execution_context\": {\"branch\": \"dev\", \"env\": \"staging\"}"
Enter
Type "  }"
Enter
Type "EOF"
Enter
Sleep 300ms

Type ""
Enter
Type "📊 Dataset Status: 2,847 examples | Ready for fine-tuning"
Enter
Sleep 300ms

# ============================================================================
# End Scene
# ============================================================================

Type ""
Enter
Type "✨ Every human correction becomes training data for better AI"
Enter
Sleep 1s
