# Documentation Index

## Architecture & Design

- **[architecture.md](architecture.md)** — System overview, component descriptions, data flow diagrams, port architecture, session key strategy, and the OpenClaw plugin API surface
- **[protocol.md](protocol.md)** — Inter-agent messaging conventions, delivery semantics, current limitations, and the concrete reliability improvement plan
- **[setup.md](setup.md)** — Practical setup and operations guide (new agent, new gateway, coordinator sweep)

## Platform Knowledge

- **[openclaw-internals.md](openclaw-internals.md)** — Reference documentation for OpenClaw's plugin system, runtime channel API, agent dispatch pipeline, Pi LLM provider abstraction, and the skills system. Captured during ansible plugin development.

## Tracking

- **[DEFECTS.md](DEFECTS.md)** — Known bugs, workarounds, and technical debt

## Quick Links

| Topic | Document |
|---|---|
| How message dispatch works | [architecture.md — Data Flow](architecture.md#data-flow) |
| Plugin API methods | [openclaw-internals.md — Plugin System](openclaw-internals.md#plugin-system) |
| Runtime channel API | [openclaw-internals.md — Runtime Channel API](openclaw-internals.md#runtime-channel-api) |
| Gemini .filter() bug | [DEFECTS.md — DEF-001](DEFECTS.md#def-001-gemini-provider-filter-crash-upstream) |
| Port architecture | [architecture.md — Port Architecture](architecture.md#port-architecture) |
