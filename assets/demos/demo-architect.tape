# Phase 6: Architect-Builder Pattern Demonstration
# VHS script showing how Haiku-powered planning + steering gate + Sonnet execution reduces costs

Output demo-architect.gif
Set Padding 24
Set Height 900
Set Width 1200
Set FontSize 14
Set Theme {"name": "Dracula", "background": "#282a36", "foreground": "#f8f8f2"}

Sleep 1s

# Scene 1: Intro - Show what we're building
Type "# Phase 6: Architect-Builder Pattern Demo"
Sleep 300ms
Enter
Sleep 300ms
Type "# User Request: Create a Python search CLI tool"
Sleep 300ms
Enter
Sleep 800ms

# Scene 2: Show the cost comparison upfront
Clear
Type "echo '📊 Cost Analysis: Single vs. Architect-Builder Approach'"
Sleep 300ms
Enter
Sleep 800ms
Type "echo ''"
Enter
Type "echo 'Traditional (Sonnet-only):'"
Sleep 200ms
Enter
Type "echo '  - Plan: Sonnet  → 2,800 tokens @ \$0.015'"
Sleep 200ms
Enter
Type "echo '  - Execute: Sonnet → 1,200 tokens @ \$0.015'"
Sleep 200ms
Enter
Type "echo '  - TOTAL: 4,000 tokens | \$0.06 cost'"
Sleep 200ms
Enter
Sleep 800ms

# Scene 3: Show smart approach
Type "echo ''"
Enter
Type "echo 'Smart Approach (Architect-Builder):'"
Sleep 200ms
Enter
Type "echo '  - Plan: Haiku (lightweight) → 450 tokens @ \$0.0027'"
Sleep 200ms
Enter
Type "echo '  - Steering Gate: User approves plan (0 tokens)'"
Sleep 200ms
Enter
Type "echo '  - Execute: Sonnet → 320 tokens @ \$0.003'"
Sleep 200ms
Enter
Type "echo '  - TOTAL: 770 tokens | \$0.0057 cost'"
Sleep 200ms
Enter
Type "echo '  - 💰 Savings: 62% cost reduction!'"
Sleep 200ms
Enter
Sleep 1000ms

# Scene 4: Simulate the workflow
Clear
Type "# Simulating Phase 6 Workflow"
Sleep 300ms
Enter
Sleep 800ms
Type "arc 'Create Python search CLI tool' --plan"
Sleep 300ms
Enter
Sleep 300ms
Type "🏗️  Architect Phase (Haiku Model)"
Sleep 100ms
Enter
Sleep 800ms

# Scene 5: Show lightweight planning
Type "⚡ Planning with lightweight tool index (50 tools instead of 1241)"
Sleep 200ms
Enter
Type "📝 Tokenometer: 450 tokens consumed | Cost: \$0.0027"
Sleep 200ms
Enter
Sleep 600ms

# Scene 6: Display the generated plan
Type ""
Sleep 100ms
Enter
Type "Generated Execution Plan:"
Sleep 200ms
Enter
Type "  Step 1: Create main.py with search algorithm"
Sleep 200ms
Enter
Type "  Step 2: Implement argument parser with argparse"
Sleep 200ms
Enter
Type "  Step 3: Add search function with substring matching"
Sleep 200ms
Enter
Type "  Step 4: Test with sample queries"
Sleep 200ms
Enter
Sleep 800ms

# Scene 7: Steering gate - pause for user approval
Type ""
Sleep 100ms
Enter
Type "🚧 Steering Gate Active - Awaiting Approval"
Sleep 300ms
Enter
Type "────────────────────────────────────────"
Sleep 200ms
Enter
Type "Review the proposed plan above and enter your decision."
Sleep 200ms
Enter
Sleep 600ms
Type "Options: (A)pprove, (M)odify, (D)eny"
Sleep 200ms
Enter
Sleep 500ms

# Scene 8: User approves
Type ">>> A"
Sleep 300ms
Enter
Type "✅ User approved. Proceeding to execution..."
Sleep 200ms
Enter
Sleep 800ms

# Scene 9: Builder phase execution
Type ""
Sleep 100ms
Enter
Type "🔨 Builder Phase (Sonnet Model)"
Sleep 300ms
Enter
Sleep 800ms

# Scene 10: Show execution progress
Type "Executing approved plan with full Sonnet power:"
Sleep 200ms
Enter
Sleep 600ms
Type "  ✓ Step 1/4 [12ms] - main.py created (def search(query, data))"
Sleep 200ms
Enter
Type "  ✓ Step 2/4 [8ms] - argument parser configured"
Sleep 200ms
Enter
Type "  ✓ Step 3/4 [5ms] - search function implemented"
Sleep 200ms
Enter
Type "  ✓ Step 4/4 [3ms] - integration tests passed"
Sleep 200ms
Enter
Type "📝 Execution tokenometer: 320 tokens consumed | Cost: \$0.003"
Sleep 200ms
Enter
Sleep 800ms

# Scene 11: Show the result
Type ""
Sleep 100ms
Enter
Type "🎉 Complete! Search CLI tool ready"
Sleep 300ms
Enter
Sleep 600ms

# Scene 12: Final summary
Clear
Type "📊 Workflow Summary"
Sleep 300ms
Enter
Sleep 800ms
Type "Total Tokens Used: 450 (planning) + 320 (execution) = 770 tokens"
Sleep 200ms
Enter
Type "Total Cost: \$0.0027 + \$0.003 = \$0.0057"
Sleep 200ms
Enter
Type "vs. Traditional: \$0.06"
Sleep 200ms
Enter
Type "Savings: 62% cost reduction"
Sleep 200ms
Enter
Sleep 600ms

# Scene 13: Key insight
Type ""
Sleep 100ms
Enter
Type "🔑 The Magic: 'Planning' doesn't need Sonnet's power!"
Sleep 300ms
Enter
Sleep 600ms
Type "   • Haiku generates reliable step-by-step plans"
Sleep 200ms
Enter
Type "   • User reviews before execution (safety gate)"
Sleep 200ms
Enter
Type "   • Only execution uses expensive Sonnet model"
Sleep 200ms
Enter
Type "   • Result: Same quality output, 62% lower cost"
Sleep 200ms
Enter
Sleep 1000ms

# Scene 14: Phase 6 badge
Type ""
Sleep 100ms
Enter
Type "✨ Phase 6C: Production-ready Architect-Builder pattern"
Sleep 300ms
Enter
Sleep 1000ms
