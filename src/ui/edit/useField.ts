import React, { useRef, useState } from "react";

export function useField(initial: string, mergeInitial?: string) {
  const effectiveInitial = mergeInitial ?? initial;
  const [value, setValue] = useState(effectiveInitial);
  const init = useRef(effectiveInitial);
  return {
    value,
    /** The value this field mounted with (its real saved value, or — for an
     * unapplied merge suggestion — the incoming value shown but not yet
     * written). Lets a caller tell "nothing happened here" apart from "this
     * is merely still showing its starting value". */
    initial: init.current,
    /** True when the current value still equals the unedited merge-incoming value. */
    isMerge: mergeInitial !== undefined && value === mergeInitial,
    isDirty: value !== init.current,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value),
    set: setValue,
    clear: () => setValue(""),
  };
}
