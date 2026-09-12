# Narraverse2.0 Architecture Master Blueprint

> Status: Architecture baseline after repository review.
>
> Purpose: Separate current implementation, frozen design, and future planning. This document is not a claim that every planned module exists.

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
 ├── Projection
 ├── Model/UI projections
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

## 2. Current Implemented Architecture

### World

World is the persistent source of truth.

It owns:

- world identity
- characters
- locations
- factions
- timeline entries
- bindings to external/master assets

It does not own:

- AI execution state
- conversation runtime state
- temporary context projections

### Binding Model

```text
Master Library Asset
        |
        v
AssetBinding
        |
        v
World Entity
```

Binding is a relationship, not a copied master record.

World-specific notes and runtime state must remain separated from master assets.

## 3. WorldContext Architecture

```text
World
  |
  v
Selection
  |
  v
Snapshot
  |
  +---- UI Projection
  |
  +---- Model Projection
  |
  v
RunContext
```

WorldContext is derived state.

Rules:

- no independent persistence
- no World replacement
- no direct model ownership
- no story state storage

## 4. Runtime Architecture

```text
InteractiveRun
 |
 +-- Task A
 |
 +-- Task B (regenerate)
 |
 +-- Task C
```

Definitions:

- InteractiveRun represents a logical runtime lineage.
- Task represents one execution attempt.
- Regenerate creates another Task under the same InteractiveRun.

## 5. Current Phase Position

Implemented:

- World data foundation
- World binding foundation
- WorldContext domain core
- Context registry
- Analysis handle lifecycle
- InteractiveRun foundation
- World Console context preview foundation

Planned:

- richer World Console management
- runtime context consumption
- knowledge workspace
- advanced relationship visualization

## 6. Future Extension Boundaries

Knowledge systems, book analysis, Obsidian integration and relationship graphs belong above Master Library / Knowledge Workspace.

Future direction:

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

Restrictions:

- Knowledge is not World truth.
- Graphs are projections, not source data.
- Notes must not automatically overwrite World.

## 7. Architectural Invariants

Must preserve:

1. World is the single persistent truth.
2. Runtime state is separated from world definition.
3. UI projections are not databases.
4. AI proposals require controlled input and human confirmation.
5. Different modes share world context but do not create incompatible world models.

## 8. Review Rule

Future architecture reviews must distinguish:

- Implemented
- Frozen design
- Planned
- Not approved
