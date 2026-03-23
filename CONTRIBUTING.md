# Contributing to TabLer

First off, thank you for considering contributing to TabLer! It's people like you that make TabLer such a great tool for data table management and visualization.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Workflow](#development-workflow)
- [Style Guidelines](#style-guidelines)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)

## Code of Conduct

This project and everyone participating in it is governed by the [TabLer Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Git

### Local Development Setup

1. **Fork and clone the repository**

   ```bash
   git clone https://github.com/minhe51805/TabLer.git
   cd TabLer
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Run the development server**

   ```bash
   npm run dev
   ```

4. **Verify everything works**
   - App: http://localhost:5173 (or the port shown in terminal)

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check [existing issues](https://github.com/minhe51805/TabLer/issues) as you might find out that you don't need to create one.

**When you are creating a bug report, please include as many details as possible:**

- Use a clear and descriptive title
- Describe the exact steps which reproduce the problem
- Provide specific examples to demonstrate the steps
- Describe the behavior you observed after following the steps
- Explain which behavior you expected to see instead and why
- Include screenshots if possible

### Suggesting Enhancements

Enhancement suggestions are tracked as [GitHub issues](https://github.com/minhe51805/TabLer/issues).

**When creating an enhancement suggestion, please include:**

- Use a clear and descriptive title
- Provide a step-by-step description of the suggested enhancement
- Provide specific examples to demonstrate the steps
- Describe the current behavior and explain which behavior you expected to see instead
- Explain why this enhancement would be useful

### Contributing Code

#### Areas for Contribution

- **Frontend (React/TypeScript)**: UI/UX improvements, new table features
- **Tauri Desktop**: Native desktop functionality
- **Data Integration**: New data source support
- **Infrastructure**: Build process, deployment
- **Documentation**: README improvements, tutorials

## Development Workflow

### Branch Strategy

- `main` - Production-ready code
- `develop` - Integration branch for features
- `feature/feature-name` - Feature development
- `bugfix/bug-name` - Bug fixes
- `hotfix/fix-name` - Critical production fixes

### Workflow Steps

1. **Create a feature branch**

   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**

   - Follow coding standards
   - Add tests if applicable
   - Update documentation

3. **Test your changes**

   ```bash
   npm run test:run
   npm run typecheck
   ```

4. **Commit your changes**

   ```bash
   git add .
   git commit -m "feat: add new feature description"
   ```

5. **Push and create PR**
   ```bash
   git push origin feature/your-feature-name
   # Create PR on GitHub targeting 'develop' branch
   ```

## Style Guidelines

### TypeScript/React

- Use TypeScript for all new code
- Follow React functional components with hooks
- Use Tailwind CSS for styling
- Use meaningful component and variable names

**Example:**

```typescript
interface TableProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
}

const DataTable = <T,>({ data, columns }: TableProps<T>) => {
  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      {/* Component implementation */}
    </div>
  );
};
```

### File Organization

```
src/
├── components/       # Reusable components
├── lib/             # Utilities
├── types/           # TypeScript definitions
└── hooks/           # Custom React hooks
```

## Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/) specification:

### Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `perf`: A code change that improves performance
- `test`: Adding missing tests or correcting existing tests
- `chore`: Changes to the build process or auxiliary tools

### Examples

```bash
git commit -m "feat: add real-time table filtering"
git commit -m "fix: resolve table sorting performance issue"
git commit -m "docs: update setup guide"
git commit -m "refactor: simplify data transformation pipeline"
```

## Pull Request Process

### Before Submitting

1. **Update documentation** if you've made changes to APIs
2. **Add tests** for new functionality
3. **Run the full test suite**
4. **Update CHANGELOG.md** with notable changes
5. **Rebase your branch** on the latest develop

### PR Requirements

- **Target the `develop` branch** (not main)
- **Clear title and description** explaining the changes
- **Reference related issues** using keywords (fixes #123)
- **Include screenshots** for UI changes
- **Ensure CI passes** (tests, linting, build)

### PR Template

When creating a PR, please use this template:

```markdown
## Description

Brief description of the changes made.

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing

- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [ ] I have tested the changes in a local development environment

## Screenshots (if applicable)

## Checklist

- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
```

## Community

### Getting Help

- **GitHub Issues**: Bug reports and feature requests
- **Discussions**: General questions and community discussions
- **Documentation**: Check the [docs folder](docs/) for detailed guides

### Recognition

Contributors will be recognized in:

- README.md contributors section
- Release notes for significant contributions
- GitHub contributors page

## Development Tips

### Useful npm Commands

```bash
npm run dev              # Start development server
npm run build           # Build for production
npm run preview         # Preview production build
npm run test            # Run tests
npm run test:run        # Run tests once
npm run typecheck       # Type check
```

### Debugging

- **Console logs**: Check browser console
- **Dev tools**: Use React DevTools for component inspection
- **Build issues**: Check terminal output for errors

### Common Issues

1. **Port conflicts**: Make sure port 5173 is free
2. **Dependencies**: Run `npm install` if you encounter import errors
3. **Type errors**: Run `npm run typecheck` to catch TypeScript issues

## License

By contributing to TabLer, you agree that your contributions will be licensed under the terms of the [GNU General Public License v3.0](LICENSE).

---

Thank you for contributing to TabLer! 🚀
