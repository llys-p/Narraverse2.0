# Narraverse2.0 Architecture Roadmap

## Phase 3 — World Foundation

Status: In progress.

Goal:

Complete World as a controllable creative foundation.

Includes:

- World Console
- Context preview
- Binding management
- Timeline compatibility
- World inspection

Does not include:

- automatic story generation
- runtime state persistence
- AI autonomous world modification

Prerequisites:

- World remains the persistent truth.
- WorldContext boundaries remain frozen.

---

## Phase 4 — Runtime Integration

(Equivalent to previous Phase 3.2 runtime connection plan.)

Goal:

Connect prepared WorldContext into creative experiences.

Order:

```text
Writing
  ↓
Game
  ↓
C0 Security Gate
  ↓
Narraverse
  ↓
Module4
```

Constraints:

- Runtime reads World context.
- Runtime does not rewrite World automatically.
- Generated content remains separate from world definitions.

Risks:

- Incorrect context ownership.
- Runtime state leaking into World.

---

## Phase 5 — Knowledge Workspace

Goal:

Create structured knowledge organization above Master Library.

Potential structure:

```text
Books
 |
Chapters
 |
Knowledge Nodes
 |
Characters
 |
Events
 |
Relationships
 |
Master Library
```

Boundaries:

Knowledge Workspace is not World truth.

Sources use the frozen reference shape:

```text
sourceKind
sourceId
sourceRevision
locator
```

Rules:

- No absolute paths as identity.
- No automatic full vault scanning.
- Analysis results do not directly become World facts.

---

## Phase 6 — Knowledge Graph

Goal:

Provide relationship visualization and analysis projections.

Possible inputs:

- books
- extracted knowledge nodes
- Master Library relationships
- Obsidian-compatible references

Rules:

- Graph is a projection.
- Graph is not the source of truth.
- Graph changes cannot silently modify World.

---

## Phase 7 — Agent Ecosystem

Goal:

Introduce specialized agents operating through controlled tools.

Possible areas:

- planning agent
- editing agent
- organization agent
- automation agent

Constraints:

- Agents do not bypass domain boundaries.
- Destructive changes require approval.

---

# Long-Term Data Flow

```text
External Knowledge
        |
        v
Knowledge Workspace
        |
        v
Master Library
        |
        v
World Binding
        |
        v
World
        |
        v
WorldContext
        |
        v
Runtime Experience
```

# Permanent Rules

- Do not create multiple world truths.
- Do not mix runtime history with world definitions.
- Do not treat AI output as authoritative data.
- Do not let projections become storage.
- Every phase must declare implementation status, prerequisites, exclusions, and risks.
