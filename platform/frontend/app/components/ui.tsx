import React from 'react';

/**
 * §0 shared control primitives (SPEC v2 §0).
 * One source of truth for buttons and inputs: these components only compose
 * the canonical token classes from globals.css — no inline styles, no local
 * radii/heights/shadows. Editor and admin consume these instead of the retired
 * .btn-ui / .field-ui families.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'destructive';
export type ButtonSize = 'lg' | 'md' | 'sm';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: '',
  secondary: 'btn--secondary',
  quiet: 'btn--quiet',
  destructive: 'btn--danger',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  lg: '', // 52px CTA — the .btn default
  md: 'btn--md', // 48px
  sm: 'btn--sm', // 44px compact (admin/editor controls)
};

function btnClass(variant: ButtonVariant, size: ButtonSize, extra?: string): string {
  return ['btn', VARIANT_CLASS[variant], SIZE_CLASS[size], extra].filter(Boolean).join(' ');
}

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
};

type ButtonAsButton = CommonProps & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & { href?: undefined };
type ButtonAsLink = CommonProps & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'className'> & { href: string };

export function Button(props: ButtonAsButton | ButtonAsLink) {
  const { variant = 'primary', size = 'lg', className, ...rest } = props;
  const cls = btnClass(variant, size, className);
  if (typeof rest.href === 'string') {
    return <a {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)} className={cls} />;
  }
  const { type = 'button', ...btnRest } = rest as React.ButtonHTMLAttributes<HTMLButtonElement>;
  return <button {...btnRest} type={type} className={cls} />;
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'> & {
  error?: boolean;
  className?: string;
};

export function Input({ error, className, ...rest }: InputProps) {
  return <input {...rest} className={['input', error ? 'input--error' : '', className].filter(Boolean).join(' ')} />;
}

type TextareaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & {
  error?: boolean;
  className?: string;
};

export function Textarea({ error, className, ...rest }: TextareaProps) {
  return <textarea {...rest} className={['textarea', error ? 'input--error' : '', className].filter(Boolean).join(' ')} />;
}
