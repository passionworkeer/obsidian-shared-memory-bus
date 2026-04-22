# Security Policy

## Supported Versions

We actively support and provide security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

We recommend always using the latest stable release to ensure you receive security patches.

## Reporting a Vulnerability

### Private Disclosure

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

**How to Report:**

1. **Do NOT** create a public GitHub issue for security vulnerabilities
2. Email the maintainers directly or use [GitHub's Private Vulnerability Reporting](https://github.com/your-repo/security/advisories/new)
3. Include as much of the following information as possible:
   - Type of vulnerability (e.g., XSS, injection, etc.)
   - Full paths of source file(s) related to the vulnerability
   - Location of the affected source code (tag/branch/commit)
   - Step-by-step instructions to reproduce the issue
   - Proof-of-concept or exploit code (if possible)
   - Impact assessment of the vulnerability

### What to Expect

**Response Timeline:**
- **Initial Response**: Within 48 hours (acknowledgment that the report was received)
- **Status Update**: Within 7 days (assessment of the report and next steps)
- **Resolution Timeline**: Varies based on severity; critical issues are addressed ASAP

**Severity Classification:**
- **Critical**: Patch released within 24-72 hours
- **High**: Patch released within 1-2 weeks
- **Medium**: Patch released within 30 days
- **Low**: Patch released in next scheduled release

## Security Best Practices for Users

When using this project, consider the following:

### Environment Variables

- Never commit secrets, API keys, or credentials to the repository
- Use environment variables or a secret manager for sensitive configuration
- Rotate credentials regularly

### Data Storage

- The shared memory bus may contain sensitive information
- Ensure proper access controls on the memory storage directory
- Review and clean up old entries periodically

### Network Security

- If exposing the MCP server over network, use authentication
- Consider TLS for connections in production environments
- Restrict access to the shared memory bus to trusted agents only

## Acknowledgments

We appreciate the security research community's efforts to improve this project's security. Contributors who report valid security vulnerabilities will be:

- Credit in the security advisory (if desired)
- Recognized in release notes for significant findings
- Invited to review patches before publication (when appropriate)

## Security Updates

Security updates will be announced through:
- GitHub Security Advisories
- Release notes (for minor/major versions)
- Project communication channels

For any security-related questions, please open an issue with the `security` label or contact the maintainers directly.
