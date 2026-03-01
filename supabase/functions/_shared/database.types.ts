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
          last_error: string | null
          metadata: Json
          mime_type: string | null
          name: string
          object_path: string
          page_count: number | null
          processed_at: string | null
          processing_status: Database["public"]["Enums"]["enum_file_processing_status"]
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
          last_error?: string | null
          metadata?: Json
          mime_type?: string | null
          name: string
          object_path: string
          page_count?: number | null
          processed_at?: string | null
          processing_status?: Database["public"]["Enums"]["enum_file_processing_status"]
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
          last_error?: string | null
          metadata?: Json
          mime_type?: string | null
          name?: string
          object_path?: string
          page_count?: number | null
          processed_at?: string | null
          processing_status?: Database["public"]["Enums"]["enum_file_processing_status"]
          size_bytes?: number | null
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
          completed_at: string | null
          created_at: string
          cron_expr: string | null
          description: string | null
          enabled_at: string | null
          id: number
          include_session_history: boolean
          last_enqueued_queue_msg_id: string | null
          last_error: string | null
          last_processed_queue_msg_id: string | null
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
          timezone: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          cron_expr?: string | null
          description?: string | null
          enabled_at?: string | null
          id?: never
          include_session_history?: boolean
          last_enqueued_queue_msg_id?: string | null
          last_error?: string | null
          last_processed_queue_msg_id?: string | null
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
          timezone?: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          cron_expr?: string | null
          description?: string | null
          enabled_at?: string | null
          id?: never
          include_session_history?: boolean
          last_enqueued_queue_msg_id?: string | null
          last_error?: string | null
          last_processed_queue_msg_id?: string | null
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
      enqueue_due_tasks: { Args: never; Returns: number }
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
      queue_delete: { Args: { p_msg_id: string }; Returns: boolean }
      queue_read: { Args: { p_qty: number; p_vt: number }; Returns: Json }
      queue_send: { Args: { p_delay?: number; p_msg: Json }; Returns: string }
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
      enum_file_processing_status:
        | "pending"
        | "processing"
        | "succeeded"
        | "failed"
        | "skipped"
      enum_memory_type: "summary" | "pinned_fact" | "note"
      enum_message_role: "assistant" | "user" | "system"
      enum_message_tool_status: "started" | "succeeded" | "failed"
      enum_message_type: "text" | "tool-call" | "file"
      enum_schedule_type: "once" | "recurring"
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
      enum_file_processing_status: [
        "pending",
        "processing",
        "succeeded",
        "failed",
        "skipped",
      ],
      enum_memory_type: ["summary", "pinned_fact", "note"],
      enum_message_role: ["assistant", "user", "system"],
      enum_message_tool_status: ["started", "succeeded", "failed"],
      enum_message_type: ["text", "tool-call", "file"],
      enum_schedule_type: ["once", "recurring"],
    },
  },
} as const

