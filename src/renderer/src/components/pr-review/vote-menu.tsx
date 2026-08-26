import * as React from 'react'
import {
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  Loader2 as Loader2Icon
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { PrVote } from '@shared/pr-review'
import type { ReviewRemoteKind } from '@/lib/pr-review'

/** Vote vocabularies per provider; Azure DevOps has the richer set. */
const OPTIONS: Record<ReviewRemoteKind, { vote: PrVote; label: string }[]> = {
  ado: [
    { vote: 'approved', label: 'Approve' },
    { vote: 'approvedWithSuggestions', label: 'Approve with suggestions' },
    { vote: 'waitingForAuthor', label: 'Wait for author' },
    { vote: 'rejected', label: 'Reject' },
    { vote: 'none', label: 'Reset vote' }
  ],
  github: [
    { vote: 'approved', label: 'Approve' },
    { vote: 'none', label: 'Comment' },
    { vote: 'rejected', label: 'Request changes' }
  ]
}

const VOTE_LABELS: Record<PrVote, string> = {
  none: 'No vote',
  approved: 'Approved',
  approvedWithSuggestions: 'Approved with suggestions',
  waitingForAuthor: 'Waiting for author',
  rejected: 'Rejected'
}

/** Single-click vote submission — no confirmation step, per "speed over ceremony". */
export function VoteMenu({
  remoteKind,
  currentVote,
  isBusy,
  onVote
}: {
  remoteKind: ReviewRemoteKind
  currentVote: PrVote
  isBusy: boolean
  onVote: (vote: PrVote) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="h-7" disabled={isBusy} aria-busy={isBusy}>
          {isBusy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {VOTE_LABELS[currentVote]}
          <ChevronDownIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS[remoteKind].map((option) => (
          <DropdownMenuItem key={option.vote} onSelect={() => onVote(option.vote)}>
            <CheckIcon
              className={
                option.vote === currentVote ? 'size-3.5 opacity-100' : 'size-3.5 opacity-0'
              }
            />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
