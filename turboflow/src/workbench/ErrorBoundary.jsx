// One bad panel must not take the whole Workbench with it.
//
// Without this, a thrown error anywhere in the tree unmounts everything and
// leaves a white page with the message only in the console. A team in the
// middle of a setup then has no tree, no viewer and nothing to click, and
// the only clue is in devtools.
import React from "react";
import { Icon } from "./icons";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Left in the console on purpose: this is the one place the stack is
    // useful, and it is what a bug report should carry.
    console.error("Workbench error", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={this.props.className || "wb-errorbox"} role="alert">
        <Icon name="warn" size={18} />
        <div>
          <strong>{this.props.title || "Something in this panel broke."}</strong>
          <p className="wb-dim">{String(this.state.error?.message || this.state.error)}</p>
          <button type="button" className="wb-btn"
            onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
