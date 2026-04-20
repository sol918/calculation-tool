"use client";

import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

interface EditableCellProps {
  value: number;
  onSave: (value: number) => void;
  format?: (v: number) => string;
  isOverride?: boolean;
  disabled?: boolean;
  className?: string;
}

export function EditableCell({ value, onSave, format, isOverride, disabled, className }: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const displayValue = format ? format(value) : value.toString();

  if (disabled) {
    return <span className={cn("tabular-nums", className)}>{displayValue}</span>;
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        className="w-24 rounded border border-input px-2 py-0.5 text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={() => {
          const parsed = parseFloat(editValue.replace(",", "."));
          if (!isNaN(parsed)) onSave(parsed);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const parsed = parseFloat(editValue.replace(",", "."));
            if (!isNaN(parsed)) onSave(parsed);
            setEditing(false);
          }
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  return (
    <span
      className={cn(
        "cursor-pointer rounded px-1 py-0.5 tabular-nums hover:bg-muted",
        isOverride && "cell-override",
        className,
      )}
      onClick={() => {
        setEditValue(value.toString());
        setEditing(true);
      }}
    >
      {displayValue}
    </span>
  );
}
