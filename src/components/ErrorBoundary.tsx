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
