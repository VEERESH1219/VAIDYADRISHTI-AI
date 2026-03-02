You are a backend security auditor.

Analyze the Express backend and frontend upload logic.

Check for:

1. Missing rate limiting
2. Missing helmet middleware
3. Missing CORS restrictions
4. MIME type validation
5. File extension validation
6. File size limits
7. Image decompression bomb risk
8. DOS attack risk via repeated requests
9. Environment variable exposure
10. Unhandled promise rejections
11. Global error handling robustness

Specifically review:

- server.js
- prescription route
- upload handling
- image preprocessing
- OCR services

Output format:

## High Severity Vulnerabilities
(Explain impact + fix)

## Medium Severity Issues

## Low Severity Issues

## Exact Fix Code Snippets

## Security Hardening Checklist
