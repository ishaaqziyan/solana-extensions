/**
 * Token-account text input plus quick-pick buttons for named accounts
 * (`deployment.knownAccounts`, written by `scripts/sync-known-accounts.ts`) —
 * so a demo user isn't forced to paste raw base58 addresses for accounts
 * this repo already knows about. Free text still works for anything else.
 */
import type { Deployment } from '../lib/deployment';

interface Props {
    deployment: Deployment;
    label: string;
    value: string;
    onChange: (value: string) => void;
}

export default function AccountPicker({ deployment, label, value, onChange }: Props) {
    const known = Object.entries(deployment.knownAccounts ?? {});

    return (
        <label class="flex-1 min-w-[14rem] text-sm">
            <span class="block text-slate-600 dark:text-slate-400">{label}</span>
            <input
                class="mt-1 w-full rounded border border-slate-300 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900"
                value={value}
                onInput={(e) => onChange((e.target as HTMLInputElement).value)}
                required
            />
            {known.length > 0 && (
                <div class="mt-1 flex flex-wrap gap-1">
                    {known.map(([name, account]) => (
                        <button
                            key={name}
                            type="button"
                            class="rounded-full bg-slate-100 px-2 py-0.5 text-xs capitalize text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                            onClick={() => onChange(account.tokenAccount)}
                        >
                            {name}
                        </button>
                    ))}
                </div>
            )}
        </label>
    );
}
