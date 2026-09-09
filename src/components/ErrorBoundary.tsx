import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode)
  onReset?: () => void
  maxRetries?: number
  onMaxRetriesExceeded?: () => void
}

interface State {
  hasError: boolean
  error?: Error
  componentStack?: string
  retryCount: number
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, retryCount: 0 }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, info)
    this.setState({ componentStack: info.componentStack ?? undefined })
  }

  handleReset = (): void => {
    const maxRetries = this.props.maxRetries ?? Infinity;
    if (this.state.retryCount >= maxRetries) {
      this.props.onMaxRetriesExceeded?.();
      return;
    }
    this.setState((prev) => ({ hasError: false, error: undefined, retryCount: prev.retryCount + 1 }))
    this.props.onReset?.()
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (typeof this.props.fallback === 'function' && this.state.error) {
        return this.props.fallback(this.state.error, this.handleReset);
      } else if (this.props.fallback) {
        return this.props.fallback as ReactNode;
      }
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center p-4">
            <h2 className="text-lg font-semibold mb-2">Something went wrong</h2>
            <p className="text-sm text-muted-foreground mb-4">{this.state.error?.message}</p>
            {import.meta.env.DEV && this.state.error ? (
              <pre className="mb-4 max-w-3xl max-h-[50vh] overflow-auto whitespace-pre-wrap text-left text-[11px] leading-snug text-red-400 bg-black/5 rounded p-2">
                {this.state.error.stack || this.state.error.message}
                {this.state.componentStack ? `\n\nComponent stack:${this.state.componentStack}` : ''}
              </pre>
            ) : null}
            <button onClick={this.handleReset} className="px-4 py-2 bg-primary text-primary-foreground rounded">
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
