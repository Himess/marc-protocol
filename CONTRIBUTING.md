# Contributing to FHE x402

## Development Setup

```bash
# Clone and install
git clone https://github.com/marc-protocol/marc.git
cd fhe-x402
npm install

# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test
```

## Code Style

- TypeScript: ESLint + Prettier (run `npm run lint` and `npm run format`)
- Solidity: Solhint (run `npm run lint`)
- All code must pass linting before commit

## Testing

- Contract tests: `npx hardhat test` (184 tests including ConfidentialACP: 44)
- SDK tests: `cd sdk && npx vitest run` (171 tests)
- Virtuals plugin: `cd packages/virtuals-plugin && npx vitest run` (30 tests)
- OpenClaw skill: `cd packages/openclaw-skill && npx vitest run` (25 tests)
- MCP server: `cd packages/mcp-server && npx vitest run`
- All tests: `npm run test:all`

## Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests for new functionality
4. Ensure all tests pass
5. Submit PR with clear description

## Commit Messages

Use conventional commits:
- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation
- `test:` — Tests
- `refactor:` — Code refactoring
- `ci:` — CI/CD changes

## Security

If you discover a security vulnerability, please email privately instead of opening a public issue. See [SECURITY.md](docs/SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the BUSL-1.1 license.
