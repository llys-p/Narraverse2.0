# Narraverse2.0 Architecture Master Blueprint

> Status: Draft / Review Required
>
> Purpose: Establish the long-term architecture map. This document is a planning source, not a statement that all modules are already implemented.

## 0. Core Principles

### Single Source of Truth

World data is the authoritative persistent source.

- World files contain durable world definitions.
- Runtime context, snapshots, projections and indexes are derived state.
- Runtime derived state must not silently rewrite World data.

### Separation of Concerns

Persistent data, runtime execution state and presentation state are separate layers.

```
Persistent Layer
    World
    Projects
    Assets

Runtime Layer
    Snapshot
    WorldContext
    RunContext
    Task
    InteractiveRun

Presentation Layer
    Console UI
    Preview UI
    Editors
```

---

# 1. Current Architecture (Implemented Direction)

## World Workspace

Purpose:

- Manage world definitions.
- Preview selected context.
- Prepare controlled context consumption.

Current implemented foundation:

```
World
 |
 +-- Snapshot
      |
      +-- Selection
      |
      +-- Projection
      |
      +-- WorldContext Registry
```

WorldContext is temporary runtime state.

It does not own:

- World files
- Story content
- Model outputs
- Permanent memories

---

# 2. Runtime Execution Model

Current frozen relationship:

```
InteractiveRun
 |
 +-- Task
 |     |
 |     +-- execution attempt
 |
 +-- Task
 |
 +-- Task
```

Definitions:

- InteractiveRun = logical conversation/generation lineage.
- Task = one execution attempt.
- Regenerate creates another Task under the same InteractiveRun.

Task completion does not destroy InteractiveRun automatically.

---

# 3. Context Flow Blueprint

```
World
  |
  v
Snapshot Builder
  |
  v
Selection + Closure Calculation
  |
  v
WorldContext
  |
  v
InteractiveRun
  |
  v
Task Execution
  |
  v
Persisted Result
```

---

# 4. Planned Console Evolution

## Phase 3.1 World Console

Goal:

Make World state understandable and controllable without changing the source of truth.

Planned areas:

- Context preview
- Selection visualization
- Source ownership
- Binding health
- Timeline compatibility
- World management tools

No automatic story generation is introduced here.

---

# 5. Long Term Roadmap

## Phase 3.x World Management

Focus:

- World inspection
- Context preparation
- Entity management
- Timeline management

## Phase 4 Runtime Integration

Focus:

- Connect prepared context to actual interaction flows.
- Complete analysisHandle to runtime path.
- Improve runtime orchestration.

## Phase 5 Agent System

Focus:

- Specialized agents.
- Tool execution.
- Controlled automation.
- Human approval boundaries.

## Phase 6 Knowledge / Content Library

Focus:

- Global content organization.
- Character cards.
- Setting cards.
- Version management.
- Import pipelines.

## Phase 7 Product Experience

Focus:

- Full creative workflow.
- Writing mode.
- Game mode.
- Character exploration.
- Rich presentation.

---

# 6. Forbidden Architectural Drift

The following must not happen without redesign review:

- WorldContext becoming a second database.
- UI state becoming persistent truth.
- Runtime state writing directly into World definitions.
- InteractiveRun storing complete world copies.
- Different modes creating independent incompatible world models.

---

# 7. Review Checklist for Future Models

When reviewing this blueprint:

1. Verify against current repository code.
2. Mark implemented vs planned separately.
3. Identify contradictions.
4. Do not add new architecture without approval.
5. Preserve World as the single source of truth.
