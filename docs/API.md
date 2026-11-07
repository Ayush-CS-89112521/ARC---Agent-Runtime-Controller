# Workflow reference

Run `npm run dev -- --help` for the current CLI flags. YAML runs use `npm run dev -- path/to/workflow.yaml`. Architect/Builder runs use `npm run dev -- "Your request" --plan`. Both commands need an authenticated Copilot CLI. See the [runtime adapter guide](RUNTIME_ADAPTERS.md) for tool grants.

A YAML workflow requires a version, a name, and an ordered list of steps. Each step needs a unique ID, one of `suggest`, `explain`, or `edit` as its agent mode, a prompt, and an output destination.

```yaml
version: "1.0"
name: Greeting
steps:
  - id: greeting
    agent: suggest
    prompt: Write a one-line welcome.
    output:
      type: variable
      name: greeting
  - id: summary
    agent: explain
    prompt: 'Explain this greeting: ${steps.greeting.output}'
    output:
      type: file
      path: summary.txt
```

Use `output.type: variable` with a name, `file` with a run-relative path, or `files` for a manifest. A dependent prompt can refer to `${steps.greeting.output}` or a field in a parsed JSON response. References must point to prior steps. File output is stored under the run's `outputs/` directory. Workflow config can set timeout, retry count, safety mode, and resource defaults.

An optional `model` on a step requests `haiku` or `sonnet`. Edit tasks and long prompts request Sonnet by default. The result distinguishes requested routing from model identity reported by the CLI. See the [two-step demo](../assets/demos/demo-simple.yaml) and [YAML schema](../src/schemas/workflow.schema.ts).
