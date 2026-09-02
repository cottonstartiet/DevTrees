import * as React from 'react'
import { MessageSquareTextIcon, MoreHorizontalIcon, PlusIcon, Trash2Icon } from 'lucide-react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem
} from '@/components/ui/sidebar'
import { useChat } from '@/contexts/chat-context'

function contextLabel(kind?: string): string {
  return kind === 'worktree' ? 'Worktree' : 'Repository'
}

export function ChatSidebar(): React.JSX.Element {
  const {
    conversations,
    activeConversation,
    loading,
    sending,
    selectConversation,
    createConversation,
    deleteConversation
  } = useChat()
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  return (
    <>
      <Sidebar collapsible="offcanvas" className="top-0 bottom-5 left-12 h-[calc(100svh-1.25rem)]">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel className="text-sm font-semibold">Chat</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className="border border-sidebar-border"
                    onClick={() => void createConversation()}
                  >
                    <PlusIcon />
                    <span>New chat</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="min-h-0 flex-1">
            <SidebarGroupLabel>Recent</SidebarGroupLabel>
            <SidebarGroupContent className="min-h-0 overflow-y-auto">
              {loading ? (
                <p className="text-sidebar-foreground/60 px-2 py-2 text-xs">Loading chats…</p>
              ) : conversations.length === 0 ? (
                <p className="text-sidebar-foreground/60 px-2 py-2 text-xs">
                  Start a chat to ask Copilot a question.
                </p>
              ) : (
                <SidebarMenu>
                  {conversations.map((conversation) => (
                    <SidebarMenuItem key={conversation.id}>
                      <SidebarMenuButton
                        isActive={conversation.id === activeConversation?.id}
                        className="h-auto min-h-9 py-1.5"
                        tooltip={conversation.title}
                        onClick={() => selectConversation(conversation.id)}
                      >
                        <MessageSquareTextIcon />
                        <span className="flex min-w-0 flex-col leading-tight">
                          <span className="truncate">{conversation.title}</span>
                          {conversation.context ? (
                            <span className="text-sidebar-foreground/60 truncate text-[10px]">
                              {contextLabel(conversation.context.kind)} ·{' '}
                              {conversation.context.name}
                            </span>
                          ) : null}
                        </span>
                      </SidebarMenuButton>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <SidebarMenuAction
                            showOnHover
                            disabled={sending && conversation.id === activeConversation?.id}
                            title="Chat actions"
                          >
                            <MoreHorizontalIcon />
                          </SidebarMenuAction>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="right" align="start">
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setDeleteId(conversation.id)}
                          >
                            <Trash2Icon />
                            Delete chat
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null)
        }}
        title="Delete chat?"
        description="This permanently removes the conversation and its Copilot session."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => {
          if (deleteId) void deleteConversation(deleteId)
        }}
      />
    </>
  )
}
