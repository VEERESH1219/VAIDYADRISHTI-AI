You are a senior backend systems architect.

Analyze the entire backend folder of this project.

Focus on:

1. Concurrency risks (especially Ollama queueing and serialization)
2. Blocking async calls
3. Missing timeouts
4. Missing circuit breakers
5. Memory leak risks
6. Error handling gaps
7. Scalability limits
8. Stage 4 fallback safety
9. Queue buildup scenarios under 5+ concurrent users

Evaluate:

- server.js
- routes/
- services/
- matchingEngine.js
- ocrService.js
- llmService.js
- pgService.js

Output format:

## Critical Issues
(Production breaking)

## Moderate Issues
(Scalability / stability risks)

## Suggested Refactors
(Specific architectural improvements)

## Code-Level Patch Suggestions
(Show exact example changes)

## Concurrency Risk Score (1-10)
