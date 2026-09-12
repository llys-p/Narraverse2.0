# Narraverse2.0 Architecture Master Blueprint

> Status: Architecture baseline after repository review.
>
> Purpose: Separate implemented capability, frozen design, and future planning. This document is not a claim that every planned module exists.

## Status Classification

- Implemented: verified in repository code.
- Frozen Design: approved architecture direction, not necessarily implemented.
- Future Plan: possible later expansion.
- Not Approved: excluded until separately reviewed.

## 1. Architecture Layers

```text
Persistent Truth Layer

World
 ├── Characters
 ├── Locations
 ├── Factions
 ├── Timeline
 └── AssetBindings

Derived Runtime Layer

WorldContext
 ├── Selection
 ├── Snapshot
 ├── UI Projection
 ├── Model Projection
 └── RunContext references

Execution Layer

InteractiveRun
 ├── Task
 ├── Turn indexes
 └── execution lifecycle

Presentation Layer

World Console
Preview UI
Editors
```

## 2. World and Binding Truth Boundary

World is the persistent truth of the world-definition domain.

It is not the universal storage layer for all project knowledge. Master Library, books, and Knowledge Workspace keep their own truth domains.

```text
Master Library Asset
        |
        v
AssetBinding
        |
        v
World
```

Binding is a relationship, not a copied master record.

Binding scopes:

```text
Binding
 ├── entity scope
 │     └── connected to concrete world entity
 │
 └── world scope
       └── valid without entity reference
```

Rules:

- masterRevision is not a live health state.
- Binding is not a second version system.
- Runtime state is not stored in Binding.

## 3. WorldContext Architecture

WorldContext is derived runtime state.

Preview path:

```text
World
 |
Snapshot
 |
UI Projection
```

Preview does:

- generate UI-readable information
- show selection and closure information

Preview does not:

- create RunContext
- occupy Registry
- generate ModelView
- persist state

Runtime path:

```text
World
 |
Snapshot
 |
Selection
 |
Projection
 |
RunContext
 |
InteractiveRun
 |
Task
```

Rules:

- no World replacement
- no independent persistence
- no story state storage

## 4. Runtime Architecture

InteractiveRun is a turn-level runtime identity, not an entire story lifetime.

```text
InteractiveRun
 |
 +-- Task A
 +-- Task B (regenerate)
 +-- Task C
```

Definitions:

- Task = one execution attempt.
- InteractiveRun = logical lineage for related execution attempts.

Lifecycle:

- New turn creates a new InteractiveRun.
- Regenerate reuses InteractiveRun only when persisted TurnIndex mapping exists.
- Missing runtime mapping creates a new Run.
- TurnIndex is written only after successful persistence.
- Registry state is not restored after restart.

## 5. Current Phase Position

Implemented:

- World data foundation.
- World binding foundation.
- WorldContext domain core.
- Context registry.
- Analysis handle lifecycle.
- InteractiveRun foundation.
- World Console context preview foundation.

Frozen Design:

- Runtime context consumption.
- Four experience modes reading World context without rewriting World.

Not yet implemented:

- Full World Console integration.
- Complete writing/game/Narraverse/Module4 context injection.

## 6. Knowledge and Graph Boundaries

```text
Book
 |
Chapter
 |
Extracted Knowledge
 |
Characters / Events / Locations
 |
Master Library
 |
Binding
 |
World
```

Knowledge systems remain separate from World.

Future references use:

```text
sourceKind
sourceId
sourceRevision
locator
```

Rules:

- Graphs are projections, not truth.
- Obsidian notes are references, not World storage.
- No automatic full vault scanning.
- AI analysis cannot directly become World fact.

## 7. Architectural Invariants

1. World is the single persistent truth of world definitions.
2. Runtime state is separated from world definitions.
3. UI projections are not databases.
4. AI proposals require controlled input and confirmation.
5. Different modes consume context without creating incompatible world models.

Future reviews must distinguish:

- Implemented
- Frozen Design
- Planned
- Not Approved
