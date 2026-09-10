import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet} from 'react-native';
import {recordError, log} from './crashlytics';

interface Props {
  children: React.ReactNode;
  fallback?: (err: Error, retry: () => void) => React.ReactNode;
}

interface State {
  err: Error | null;
}

/**
 * Top-level React error boundary. Catches render-phase errors that
 * would otherwise unmount the entire tree, ships them to Crashlytics
 * with the React component stack as breadcrumbs, and shows a recovery
 * screen so the user can retry without quitting the app.
 *
 * Mounted at the root of App.tsx — anything below it is protected.
 *
 * NOTE: Does NOT catch errors in event handlers, async code, or the
 * native side. Those still flow through `ErrorUtils.setGlobalHandler`
 * in index.js (which also reports to Crashlytics via recordError).
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = {err: null};

  static getDerivedStateFromError(err: Error): State {
    return {err};
  }

  componentDidCatch(err: Error, info: React.ErrorInfo): void {
    log(`[bravo.error-boundary] caught ${err.name}: ${err.message}`);
    if (info.componentStack) {
      log(`[bravo.error-boundary] component-stack ${info.componentStack.slice(0, 800)}`);
    }
    recordError(err, {kind: 'react-error-boundary'});
  }

  retry = (): void => {
    this.setState({err: null});
  };

  render(): React.ReactNode {
    if (this.state.err) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.err, this.retry);
      }
      return (
        <View style={styles.root}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            The app hit an unexpected error. We've reported it. Tap below
            to try again.
          </Text>
          <TouchableOpacity style={styles.button} onPress={this.retry}>
            <Text style={styles.buttonText}>Retry</Text>
          </TouchableOpacity>
          {__DEV__ && (
            <Text style={styles.dev} numberOfLines={20}>
              {this.state.err.name}: {this.state.err.message}
              {'\n'}
              {this.state.err.stack}
            </Text>
          )}
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 12,
  },
  body: {
    color: '#B8B8B8',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#1E5BFF',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  dev: {
    color: '#FF6464',
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 32,
    width: '100%',
  },
});
