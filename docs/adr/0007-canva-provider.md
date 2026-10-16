# ADR 0007: Canva editable round trip

Canva is an editable source, not an asset store. The service persists only workspace-scoped design references and requested page order, exports through the provider, validates short-lived pages, and stores each synchronization as new immutable assets. A synchronization never claims that a local edit was written back to Canva.
