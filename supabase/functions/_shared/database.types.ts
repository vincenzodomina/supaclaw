export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      files: {
        Row: {
          bucket: string
          content: string
          created_at: string
          embedding: string | null
          fts: unknown
          id: string
          metadata: Json
          mime_type: string | null
          name: string
          object_path: string
          size_bytes: number | null
          updated_at: string
        }
        Insert: {
          bucket: string
          content?: string
          created_at?: string
          embedding?: string | null
          fts?: unknown
          id?: string
          metadata?: Json
          mime_type?: string | null
          name: string
          object_path: string
          size_bytes?: number | null
          updated_at?: string
        }
        Update: {
          bucket?: string
          content?: string
          created_at?: string
          embedding?: string | null
          fts?: unknown
          id?: string
          metadata?: Json
          mime_type?: string | null
          name?: string
          object_path?: string
          size_bytes?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      jobs: {
        Row: {
          attempts: number
          created_at: string
          dedupe_key: string
          id: number
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          run_at: string
          status: string
          type: Database["public"]["Enums"]["enum_job_type"]
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          dedupe_key: string
          id?: never
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          run_at?: string
          status?: string
          type: Database["public"]["Enums"]["enum_job_type"]
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          dedupe_key?: string
          id?: never
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          run_at?: string
          status?: string
          type?: Database["public"]["Enums"]["enum_job_type"]
          updated_at?: string
        }
        Relationships: []
      }
      memories: {
        Row: {
          content: string
          created_at: string
          embedding: string | null
          fts: unknown
          id: number
          metadata: Json | null
          priority: number | null
          session_id: string | null
          type: Database["public"]["Enums"]["enum_memory_type"]
          updated_at: string
          url: string | null
        }
        Insert: {
          content: string
          created_at?: string
          embedding?: string | null
          fts?: unknown
          id?: never
          metadata?: Json | null
          priority?: number | null
          session_id?: string | null
          type: Database["public"]["Enums"]["enum_memory_type"]
          updated_at?: string
          url?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          embedding?: string | null
          fts?: unknown
          id?: never
          metadata?: Json | null
          priority?: number | null
          session_id?: string | null
          type?: Database["public"]["Enums"]["enum_memory_type"]
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "memories_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          channel_chat_id: string | null
          channel_from_user_id: string | null
          channel_message_id: string | null
          channel_sent_at: string | null
          channel_update_id: string | null
          content: string
          created_at: string
          embedding: string | null
          file_id: string | null
          fts: unknown
          id: number
          reply_to_message_id: number | null
          role: Database["public"]["Enums"]["enum_message_role"]
          session_id: string
          tool_duration_ms: number | null
          tool_error: string | null
          tool_name: string | null
          tool_result: Json | null
          tool_status:
            | Database["public"]["Enums"]["enum_message_tool_status"]
            | null
          type: Database["public"]["Enums"]["enum_message_type"]
          updated_at: string
        }
        Insert: {
          channel_chat_id?: string | null
          channel_from_user_id?: string | null
          channel_message_id?: string | null
          channel_sent_at?: string | null
          channel_update_id?: string | null
          content: string
          created_at?: string
          embedding?: string | null
          file_id?: string | null
          fts?: unknown
          id?: never
          reply_to_message_id?: number | null
          role: Database["public"]["Enums"]["enum_message_role"]
          session_id: string
          tool_duration_ms?: number | null
          tool_error?: string | null
          tool_name?: string | null
          tool_result?: Json | null
          tool_status?:
            | Database["public"]["Enums"]["enum_message_tool_status"]
            | null
          type: Database["public"]["Enums"]["enum_message_type"]
          updated_at?: string
        }
        Update: {
          channel_chat_id?: string | null
          channel_from_user_id?: string | null
          channel_message_id?: string | null
          channel_sent_at?: string | null
          channel_update_id?: string | null
          content?: string
          created_at?: string
          embedding?: string | null
          file_id?: string | null
          fts?: unknown
          id?: never
          reply_to_message_id?: number | null
          role?: Database["public"]["Enums"]["enum_message_role"]
          session_id?: string
          tool_duration_ms?: number | null
          tool_error?: string | null
          tool_name?: string | null
          tool_result?: Json | null
          tool_status?:
            | Database["public"]["Enums"]["enum_message_tool_status"]
            | null
          type?: Database["public"]["Enums"]["enum_message_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_reply_to_message_id_fkey"
            columns: ["reply_to_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          channel: Database["public"]["Enums"]["enum_channel_provider"]
          channel_chat_id: string
          created_at: string
          id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          channel: Database["public"]["Enums"]["enum_channel_provider"]
          channel_chat_id: string
          created_at?: string
          id?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["enum_channel_provider"]
          channel_chat_id?: string
          created_at?: string
          id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          created_at: string
          cron_expr: string | null
          description: string | null
          enabled_at: string | null
          id: number
          last_error: string | null
          last_run_at: string | null
          name: string
          next_run_at: string | null
          prompt: string | null
          run_at: string | null
          run_count: number
          schedule_type:
            | Database["public"]["Enums"]["enum_schedule_type"]
            | null
          session_id: string | null
          task_type: Database["public"]["Enums"]["enum_task_type"]
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          cron_expr?: string | null
          description?: string | null
          enabled_at?: string | null
          id?: never
          last_error?: string | null
          last_run_at?: string | null
          name: string
          next_run_at?: string | null
          prompt?: string | null
          run_at?: string | null
          run_count?: number
          schedule_type?:
            | Database["public"]["Enums"]["enum_schedule_type"]
            | null
          session_id?: string | null
          task_type?: Database["public"]["Enums"]["enum_task_type"]
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          cron_expr?: string | null
          description?: string | null
          enabled_at?: string | null
          id?: never
          last_error?: string | null
          last_run_at?: string | null
          name?: string
          next_run_at?: string | null
          prompt?: string | null
          run_at?: string | null
          run_count?: number
          schedule_type?:
            | Database["public"]["Enums"]["enum_schedule_type"]
            | null
          session_id?: string | null
          task_type?: Database["public"]["Enums"]["enum_task_type"]
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_jobs: {
        Args: {
          p_lock_timeout_seconds?: number
          p_locked_by: string
          p_max_jobs?: number
        }
        Returns: {
          attempts: number
          created_at: string
          dedupe_key: string
          id: number
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          run_at: string
          status: string
          type: Database["public"]["Enums"]["enum_job_type"]
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      enqueue_due_tasks: { Args: never; Returns: number }
      enqueue_job: {
        Args: {
          p_dedupe_key: string
          p_max_attempts?: number
          p_payload?: Json
          p_run_at?: string
          p_type: string
        }
        Returns: number
      }
      hybrid_search: {
        Args: {
          filter_bucket?: string
          filter_object_path_prefix?: string
          filter_role?: Database["public"]["Enums"]["enum_message_role"][]
          filter_session_id?: string
          filter_type?: Database["public"]["Enums"]["enum_memory_type"][]
          full_text_weight?: number
          match_count: number
          query_embedding: string
          query_text: string
          rrf_k?: number
          search_tables?: string[]
          semantic_weight?: number
        }
        Returns: Json
      }
      job_fail: {
        Args: { p_error: string; p_job_id: number; p_retry_in_seconds?: number }
        Returns: undefined
      }
      job_succeed: { Args: { p_job_id: number }; Returns: undefined }
    }
    Enums: {
      enum_channel_provider:
        | "telegram"
        | "slack"
        | "teams"
        | "whatsapp"
        | "discord"
        | "imessage"
        | "phone"
        | "email"
        | "web"
        | "mobile"
        | "desktop"
        | "api"
      enum_job_type:
        | "embed_memory"
        | "embed_message"
        | "embed_file"
        | "trigger"
        | "run_task"
      enum_memory_type: "summary" | "pinned_fact" | "note"
      enum_message_role: "assistant" | "user" | "system"
      enum_message_tool_status: "started" | "succeeded" | "failed"
      enum_message_type: "text" | "tool-call" | "file"
      enum_schedule_type: "once" | "recurring"
      enum_task_type: "reminder" | "agent_turn" | "backlog"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      enum_channel_provider: [
        "telegram",
        "slack",
        "teams",
        "whatsapp",
        "discord",
        "imessage",
        "phone",
        "email",
        "web",
        "mobile",
        "desktop",
        "api",
      ],
      enum_job_type: [
        "embed_memory",
        "embed_message",
        "embed_file",
        "trigger",
        "run_task",
      ],
      enum_memory_type: ["summary", "pinned_fact", "note"],
      enum_message_role: ["assistant", "user", "system"],
      enum_message_tool_status: ["started", "succeeded", "failed"],
      enum_message_type: ["text", "tool-call", "file"],
      enum_schedule_type: ["once", "recurring"],
      enum_task_type: ["reminder", "agent_turn", "backlog"],
    },
  },
} as const

