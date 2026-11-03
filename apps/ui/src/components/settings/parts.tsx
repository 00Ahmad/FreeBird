import type { InputHTMLAttributes, ReactNode } from "react";

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div>
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-[12.5px] text-ink-3">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  control = true,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  /** False when the content isn't a form field (e.g. buttons): a label would click them when its text is clicked. */
  control?: boolean;
}) {
  const Wrapper = control ? "label" : "div";
  return (
    <Wrapper className="flex flex-col gap-1">
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-ink-3">{hint}</span>}
    </Wrapper>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-8 min-w-0 rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent ${props.className ?? ""}`}
    />
  );
}
