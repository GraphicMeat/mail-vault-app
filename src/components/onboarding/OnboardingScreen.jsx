import React from 'react';

/**
 * One onboarding step as one screen: a heading, the step's content filling
 * what is left of the window, and one footer that never moves. The footer
 * holds a quiet secondary action on the left and the way on, on the right, so
 * Continue sits in the same place on every step. Nothing here scrolls: a step
 * whose content cannot fit is a step to make smaller, not a page to scroll.
 */
export function OnboardingScreen({ title, subtitle, aside = null, secondary = null, primary, className = '', children }) {
  return (
    <div className={`onboarding-screen ${className}`}>
      {(title || aside) && (
        <header className="onboarding-screen-heading">
          {title && <div className="onboarding-screen-title">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>}
          {aside}
        </header>
      )}
      <div className="onboarding-screen-body">{children}</div>
      <footer className="onboarding-footer">
        {secondary}
        <span className="onboarding-footer-gap" />
        {primary}
      </footer>
    </div>
  );
}
