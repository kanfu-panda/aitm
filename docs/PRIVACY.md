# Privacy Policy

_Last updated: June 2026_

## Overview

aitm is a desktop terminal application. This policy describes what data aitm handles and how it is used.

## Data aitm Does NOT Collect

aitm does not:
- Collect or transmit telemetry, analytics, or usage statistics
- Store your data on any server operated by this project
- Create user accounts or user profiles
- Share any data with third parties beyond what you explicitly configure

## AI Provider Requests

aitm integrates with third-party AI providers (OpenAI, Anthropic, DeepSeek, Alibaba Cloud DashScope, Zhipu AI, Moonshot). When you use the AI sidebar:

- Your messages and any context you include (file contents, terminal history) are sent **directly from your machine to the AI provider you have configured**
- aitm acts as a local proxy — it never routes your data through any intermediate server
- The data handling practices of each provider are governed by their respective privacy policies

You are responsible for choosing which AI provider to use and what context to include in AI requests.

## Local Data Storage

aitm stores the following data **locally on your machine only**:

- Conversation history (SQLite database in the app data directory)
- Application settings and preferences
- Project scope configurations

This data never leaves your device except as part of AI provider requests you initiate.

## API Keys

API keys you enter in aitm are stored locally in the app configuration directory. They are never transmitted anywhere except to the respective AI provider's API endpoint.

## Tool Call Safety

When the AI requests to run commands or access files, aitm requires your explicit confirmation before executing any high-risk operation. The safety system operates entirely locally.

## Changes to This Policy

If this policy changes materially, the update will be noted in the repository changelog and reflected in the "Last updated" date above.

## Contact

For privacy-related questions, open an issue at https://github.com/kanfu-panda/aitm/issues
