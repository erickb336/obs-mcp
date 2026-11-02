# obs-mcp

**obs-mcp is a local MCP server for OBS Studio that records a video call and checks the saved file, to report whether sound from both sides is there.**

> **Status: design stage. Nothing is built and nothing works yet.**
> This repository holds only this README and the licence. There is nothing to install or run.

Contents: [Goal](#goal) · [Planned shape](#planned-shape) · [Recording rule](#recording-rule) · [Platforms](#platforms) · [Before you turn on obs-websocket](#before-you-turn-on-obs-websocket) · [Consent to record](#consent-to-record) · [Licence](#licence)

## Goal

A video call can be recorded with no sound from one side. You find out only when you play the file.

obs-mcp is planned to close that gap. It will control OBS Studio through MCP, measure each audio track of the saved file, and report whether sound from both sides is present.

## Planned shape

This is the plan. None of it is built.

| Part | Plan |
| --- | --- |
| Language | TypeScript |
| Tools | Seven MCP tools |
| Transport | stdio. The server opens no network port of its own. |
| Link to OBS | obs-websocket |

## Recording rule

The server never stops a recording unless the user requests it.

## Platforms

Version 1 targets macOS. It is meant to work on any supported Mac, not on one machine. Other systems may follow.

## Before you turn on obs-websocket

Read this before you turn on the obs-websocket server in OBS Studio.

- obs-websocket listens on all network interfaces.
- It has no option to listen on localhost only.
- Other devices on your network can reach it. Set a password, and check who can reach your computer on the network.

## Consent to record

A person may need the consent of the others on a call before recording it. The rules depend on the place. This is not legal advice.

## Licence

[MIT](LICENSE)
