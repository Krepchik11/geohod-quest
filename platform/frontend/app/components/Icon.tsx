'use client';

import React from 'react';

/**
 * Icon - thin wrapper for design .ic (background via --ic custom prop).
 * Usage: <Icon name="star-24--gold" className="..." /> or style override.
 * Keeps design CSS intact. Small, explicit, reusable.
 * For composites (globe, mail, user) prefer the CSS spans in place or extend.
 */
export default function Icon({
  name,
  className = '',
  style,
  ...props
}: {
  name?: string;
  className?: string;
  style?: React.CSSProperties;
} & React.HTMLAttributes<HTMLSpanElement>) {
  const icStyle: React.CSSProperties & { '--ic'?: string } = name
    ? { '--ic': `url('/assets/icons/c/${name}.svg')`, ...(style || {}) }
    : (style || {});
  return (
    <span
      className={`ic ${className}`}
      style={icStyle}
      {...props}
    />
  );
}
