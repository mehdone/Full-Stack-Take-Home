# C4 Model — Highwood Emissions Data Platform

This directory contains the C4 model for the system, rendered as PlantUML.
Each file is a single diagram. Render with any PlantUML toolchain
(`plantuml file.puml`, the VS Code extension, or `https://www.plantuml.com/plantuml`).

All diagrams use the [`C4-PlantUML`](https://github.com/plantuml-stdlib/C4-PlantUML)
standard library (loaded over HTTPS via `!include`); no local install required.

| File                                | Level    | Subject                                    |
| ----------------------------------- | -------- | ------------------------------------------ |
| `C1_context.puml`                   | Context  | Whole system + external actors             |
| `C2_containers.puml`                | Container| All deployable units                       |
| `C3_api_components.puml`            | Component| Inside `apps/api` (NestJS HTTP API)        |
| `C3_consumer_components.puml`       | Component| Inside `apps/consumer` (Kafka worker)      |
| `C3_outbox_relay_components.puml`   | Component| Inside `apps/outbox-relay`                 |
| `C3_metrics_relay_components.puml`  | Component| Inside `apps/metrics-relay` (Redis sum writer) |
| `C3_system_alerts_components.puml`  | Component| Inside `apps/system-alerts`                |
| `C3_alerting_components.puml`       | Component| Inside `apps/alerting` (HTTP sink)         |
| `C3_web_components.puml`            | Component| Inside `apps/web` (Next.js dashboard)      |
| `dynamic_ingest.puml`               | Dynamic  | Runtime sequence of a `/ingest` request    |
| `deployment.puml`                   | Deploy   | docker-compose topology                    |

The model is descriptive, not aspirational: every container, component, and
relationship reflects code that exists on `main` as of 2026-05-20.
