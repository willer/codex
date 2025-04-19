# Two-Agent Architecture Demo

This example demonstrates the Architect/Coder two-agent architecture in Codex.

## What is the Two-Agent Architecture?

The two-agent architecture is a pipeline that consists of:

1. **Architect** (larger model, e.g., GPT-4o): Plans the changes to be made and creates a structured Change Plan.
2. **Coder** (smaller model, e.g., GPT-3.5-turbo): Implements the individual actions from the Change Plan.

This separation offers several advantages:
- **Cost efficiency**: Smaller models are used for most of the implementation work
- **Determinism**: Planning and execution are clearly separated
- **Traceability**: Each change can be traced back to the original plan

## How to Run

To run this demo:

```bash
cd examples/two-agent-demo
./run.sh
```

The script will create a directory in `./runs` with the timestamp as the ID, which will contain the output log and a README.

## Implementation Details

The two-agent architecture consists of these core components:

1. **Change Plan Schema**: A structured JSON format for the Architect's plan
2. **Orchestrator**: A state machine that controls the flow between the Architect and Coder
3. **Context Management**: Provides the right context to each agent
4. **Failure & Recovery Logic**: Handles errors and can replan if necessary

## Cost Savings

By delegating most code generation to a smaller model, the two-agent architecture typically reduces costs by approximately 70-80% compared to using a single large model for everything.