export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      applicant_notification_outbox: {
        Row: {
          application_id: string
          attempts: number
          claimed_at: string | null
          created_at: string
          dedupe_key: string
          event_type: string
          id: string
          last_error: string | null
          next_attempt_at: string
          payload: Json
          provider_message_id: string | null
          recipient_email: string
          recipient_name: string
          sent_at: string | null
          status: Database["public"]["Enums"]["applicant_notification_status"]
          updated_at: string
        }
        Insert: {
          application_id: string
          attempts?: number
          claimed_at?: string | null
          created_at?: string
          dedupe_key: string
          event_type: string
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          payload?: Json
          provider_message_id?: string | null
          recipient_email: string
          recipient_name: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["applicant_notification_status"]
          updated_at?: string
        }
        Update: {
          application_id?: string
          attempts?: number
          claimed_at?: string | null
          created_at?: string
          dedupe_key?: string
          event_type?: string
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          payload?: Json
          provider_message_id?: string | null
          recipient_email?: string
          recipient_name?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["applicant_notification_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "applicant_notification_outbox_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      applicants: {
        Row: {
          address: string | null
          barangay: string | null
          city: string | null
          cover_letter: string | null
          created_at: string
          email: string
          first_name: string
          id: string
          last_name: string
          middle_name: string | null
          phone: string | null
          province: string | null
          resume_url: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          barangay?: string | null
          city?: string | null
          cover_letter?: string | null
          created_at?: string
          email: string
          first_name: string
          id?: string
          last_name: string
          middle_name?: string | null
          phone?: string | null
          province?: string | null
          resume_url?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          barangay?: string | null
          city?: string | null
          cover_letter?: string | null
          created_at?: string
          email?: string
          first_name?: string
          id?: string
          last_name?: string
          middle_name?: string | null
          phone?: string | null
          province?: string | null
          resume_url?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      application_history: {
        Row: {
          actor_id: string | null
          application_id: string
          created_at: string
          event: string
          id: string
          notes: string | null
        }
        Insert: {
          actor_id?: string | null
          application_id: string
          created_at?: string
          event: string
          id?: string
          notes?: string | null
        }
        Update: {
          actor_id?: string | null
          application_id?: string
          created_at?: string
          event?: string
          id?: string
          notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "application_history_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_history_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      applications: {
        Row: {
          applicant_address: string | null
          applicant_barangay: string | null
          applicant_birth_date: string | null
          applicant_city: string | null
          applicant_cover_letter: string | null
          applicant_email: string | null
          applicant_first_name: string | null
          applicant_gender: string | null
          applicant_government_id_path: string | null
          applicant_id: string
          applicant_last_name: string | null
          applicant_middle_name: string | null
          applicant_nationality: string | null
          applicant_phone: string | null
          applicant_province: string | null
          applicant_resume_url: string | null
          created_at: string
          final_interviewer_id: string | null
          id: string
          job_posting_id: string
          notes: string | null
          reference_code: string
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["application_status"]
          updated_at: string
        }
        Insert: {
          applicant_address?: string | null
          applicant_barangay?: string | null
          applicant_birth_date?: string | null
          applicant_city?: string | null
          applicant_cover_letter?: string | null
          applicant_email?: string | null
          applicant_first_name?: string | null
          applicant_gender?: string | null
          applicant_government_id_path?: string | null
          applicant_id: string
          applicant_last_name?: string | null
          applicant_middle_name?: string | null
          applicant_nationality?: string | null
          applicant_phone?: string | null
          applicant_province?: string | null
          applicant_resume_url?: string | null
          created_at?: string
          final_interviewer_id?: string | null
          id?: string
          job_posting_id: string
          notes?: string | null
          reference_code?: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["application_status"]
          updated_at?: string
        }
        Update: {
          applicant_address?: string | null
          applicant_barangay?: string | null
          applicant_birth_date?: string | null
          applicant_city?: string | null
          applicant_cover_letter?: string | null
          applicant_email?: string | null
          applicant_first_name?: string | null
          applicant_gender?: string | null
          applicant_government_id_path?: string | null
          applicant_id?: string
          applicant_last_name?: string | null
          applicant_middle_name?: string | null
          applicant_nationality?: string | null
          applicant_phone?: string | null
          applicant_province?: string | null
          applicant_resume_url?: string | null
          created_at?: string
          final_interviewer_id?: string | null
          id?: string
          job_posting_id?: string
          notes?: string | null
          reference_code?: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["application_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "applications_applicant_id_fkey"
            columns: ["applicant_id"]
            isOneToOne: false
            referencedRelation: "applicants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_final_interviewer_id_fkey"
            columns: ["final_interviewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_job_posting_id_fkey"
            columns: ["job_posting_id"]
            isOneToOne: false
            referencedRelation: "job_postings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_records: {
        Row: {
          attendance_date: string
          created_at: string
          employee_id: string
          id: string
          late_minutes: number
          overtime_minutes: number
          status: Database["public"]["Enums"]["attendance_status"]
          time_in: string | null
          time_out: string | null
          undertime_minutes: number
          updated_at: string
          working_hours: number
        }
        Insert: {
          attendance_date: string
          created_at?: string
          employee_id: string
          id?: string
          late_minutes?: number
          overtime_minutes?: number
          status?: Database["public"]["Enums"]["attendance_status"]
          time_in?: string | null
          time_out?: string | null
          undertime_minutes?: number
          updated_at?: string
          working_hours?: number
        }
        Update: {
          attendance_date?: string
          created_at?: string
          employee_id?: string
          id?: string
          late_minutes?: number
          overtime_minutes?: number
          status?: Database["public"]["Enums"]["attendance_status"]
          time_in?: string | null
          time_out?: string | null
          undertime_minutes?: number
          updated_at?: string
          working_hours?: number
        }
        Relationships: [
          {
            foreignKeyName: "attendance_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          id: string
          ip_address: string | null
          new_data: Json | null
          old_data: Json | null
          record_id: string | null
          table_name: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      branch_pos_settings: {
        Row: {
          branch_id: string
          created_at: string
          fees: Json
          payment_qr_path: string | null
          updated_at: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          fees?: Json
          payment_qr_path?: string | null
          updated_at?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          fees?: Json
          payment_qr_path?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branch_pos_settings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: true
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_pos_settings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: true
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      branches: {
        Row: {
          address: string | null
          created_at: string
          id: string
          is_active: boolean
          latitude: number | null
          longitude: number | null
          name: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          latitude?: number | null
          longitude?: number | null
          name: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          latitude?: number | null
          longitude?: number | null
          name?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      budget_allocations: {
        Row: {
          allocated_to: string
          amount: number
          budget_id: string
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          reference: string | null
          released_at: string | null
          released_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          allocated_to: string
          amount: number
          budget_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          reference?: string | null
          released_at?: string | null
          released_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          allocated_to?: string
          amount?: number
          budget_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          reference?: string | null
          released_at?: string | null
          released_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "budget_allocations_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budget_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_allocations_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budgets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_allocations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_allocations_released_by_fkey"
            columns: ["released_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      budgets: {
        Row: {
          alert_threshold: number
          amount: number
          approved_at: string | null
          approved_by: string | null
          created_at: string
          created_by: string | null
          department_id: string | null
          end_date: string | null
          finance_category_id: string | null
          fiscal_year: number
          id: string
          name: string
          period: string
          review_note: string | null
          start_date: string | null
          status: string
          updated_at: string
        }
        Insert: {
          alert_threshold?: number
          amount?: number
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          end_date?: string | null
          finance_category_id?: string | null
          fiscal_year?: number
          id?: string
          name: string
          period?: string
          review_note?: string | null
          start_date?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          alert_threshold?: number
          amount?: number
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          end_date?: string | null
          finance_category_id?: string | null
          fiscal_year?: number
          id?: string
          name?: string
          period?: string
          review_note?: string | null
          start_date?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "budgets_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budgets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budgets_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budgets_finance_category_id_fkey"
            columns: ["finance_category_id"]
            isOneToOne: false
            referencedRelation: "finance_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      change_requests: {
        Row: {
          created_at: string
          id: string
          operation: Database["public"]["Enums"]["change_request_operation"]
          payload: Json
          rejection_reason: string | null
          requested_at: string
          requested_by: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["change_request_status"]
          summary: string
          system_access: Json | null
          target_id: string | null
          target_table: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          operation: Database["public"]["Enums"]["change_request_operation"]
          payload?: Json
          rejection_reason?: string | null
          requested_at?: string
          requested_by: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["change_request_status"]
          summary: string
          system_access?: Json | null
          target_id?: string | null
          target_table: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          operation?: Database["public"]["Enums"]["change_request_operation"]
          payload?: Json
          rejection_reason?: string | null
          requested_at?: string
          requested_by?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["change_request_status"]
          summary?: string
          system_access?: Json | null
          target_id?: string | null
          target_table?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "change_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_settlement_items: {
        Row: {
          amount: number
          created_at: string
          id: string
          pos_sale_id: string
          settlement_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          pos_sale_id: string
          settlement_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          pos_sale_id?: string
          settlement_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_settlement_items_pos_sale_id_fkey"
            columns: ["pos_sale_id"]
            isOneToOne: false
            referencedRelation: "pos_sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlement_items_settlement_id_fkey"
            columns: ["settlement_id"]
            isOneToOne: false
            referencedRelation: "collection_settlement_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlement_items_settlement_id_fkey"
            columns: ["settlement_id"]
            isOneToOne: false
            referencedRelation: "collection_settlements"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_settlements: {
        Row: {
          branch_id: string | null
          created_at: string
          decision_reason: string | null
          destination_account_id: string
          fee_amount: number
          id: string
          kind: string
          notes: string | null
          payment_method: string | null
          prepared_by: string | null
          reference: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          settlement_date: string
          settlement_no: string | null
          status: string
          submitted_at: string | null
          updated_at: string
        }
        Insert: {
          branch_id?: string | null
          created_at?: string
          decision_reason?: string | null
          destination_account_id: string
          fee_amount?: number
          id?: string
          kind: string
          notes?: string | null
          payment_method?: string | null
          prepared_by?: string | null
          reference?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          settlement_date: string
          settlement_no?: string | null
          status?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Update: {
          branch_id?: string | null
          created_at?: string
          decision_reason?: string | null
          destination_account_id?: string
          fee_amount?: number
          id?: string
          kind?: string
          notes?: string | null
          payment_method?: string | null
          prepared_by?: string | null
          reference?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          settlement_date?: string
          settlement_no?: string | null
          status?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_settlements_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlements_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlements_destination_account_id_fkey"
            columns: ["destination_account_id"]
            isOneToOne: false
            referencedRelation: "treasury_account_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlements_destination_account_id_fkey"
            columns: ["destination_account_id"]
            isOneToOne: false
            referencedRelation: "treasury_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlements_prepared_by_fkey"
            columns: ["prepared_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlements_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      deployment_records: {
        Row: {
          application_id: string
          assigned_branch: string | null
          branch_id: string | null
          created_at: string
          deployed_by: string | null
          deployment_date: string
          id: string
          remarks: string | null
          reporting_manager: string | null
          reporting_time: string | null
          updated_at: string
          work_location: string | null
          work_location_id: string | null
          work_schedule_id: string | null
        }
        Insert: {
          application_id: string
          assigned_branch?: string | null
          branch_id?: string | null
          created_at?: string
          deployed_by?: string | null
          deployment_date: string
          id?: string
          remarks?: string | null
          reporting_manager?: string | null
          reporting_time?: string | null
          updated_at?: string
          work_location?: string | null
          work_location_id?: string | null
          work_schedule_id?: string | null
        }
        Update: {
          application_id?: string
          assigned_branch?: string | null
          branch_id?: string | null
          created_at?: string
          deployed_by?: string | null
          deployment_date?: string
          id?: string
          remarks?: string | null
          reporting_manager?: string | null
          reporting_time?: string | null
          updated_at?: string
          work_location?: string | null
          work_location_id?: string | null
          work_schedule_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deployment_records_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: true
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deployment_records_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deployment_records_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deployment_records_deployed_by_fkey"
            columns: ["deployed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deployment_records_work_location_id_fkey"
            columns: ["work_location_id"]
            isOneToOne: false
            referencedRelation: "work_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deployment_records_work_schedule_id_fkey"
            columns: ["work_schedule_id"]
            isOneToOne: false
            referencedRelation: "work_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_documents: {
        Row: {
          document_type: string
          employee_id: string
          file_url: string
          id: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          document_type: string
          employee_id: string
          file_url: string
          id?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          document_type?: string
          employee_id?: string
          file_url?: string
          id?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_history: {
        Row: {
          actor_id: string | null
          created_at: string
          employee_id: string
          event: string
          id: string
          notes: string | null
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          employee_id: string
          event: string
          id?: string
          notes?: string | null
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          employee_id?: string
          event?: string
          id?: string
          notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_history_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_history_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          address: string | null
          application_id: string | null
          barangay: string | null
          basic_salary: number
          benefits: string | null
          birth_date: string | null
          city: string | null
          civil_status: string | null
          created_at: string
          currency: string
          department_id: string | null
          email: string
          employee_number: string
          employment_status: Database["public"]["Enums"]["employment_status"]
          employment_type: Database["public"]["Enums"]["employment_type"]
          first_name: string
          gender: string | null
          hire_date: string
          id: string
          last_name: string
          middle_name: string | null
          nationality: string | null
          phone: string | null
          photo_url: string | null
          position_id: string | null
          province: string | null
          salary_grade_id: string | null
          updated_at: string
          work_schedule_id: string | null
        }
        Insert: {
          address?: string | null
          application_id?: string | null
          barangay?: string | null
          basic_salary?: number
          benefits?: string | null
          birth_date?: string | null
          city?: string | null
          civil_status?: string | null
          created_at?: string
          currency?: string
          department_id?: string | null
          email: string
          employee_number?: string
          employment_status?: Database["public"]["Enums"]["employment_status"]
          employment_type?: Database["public"]["Enums"]["employment_type"]
          first_name: string
          gender?: string | null
          hire_date?: string
          id?: string
          last_name: string
          middle_name?: string | null
          nationality?: string | null
          phone?: string | null
          photo_url?: string | null
          position_id?: string | null
          province?: string | null
          salary_grade_id?: string | null
          updated_at?: string
          work_schedule_id?: string | null
        }
        Update: {
          address?: string | null
          application_id?: string | null
          barangay?: string | null
          basic_salary?: number
          benefits?: string | null
          birth_date?: string | null
          city?: string | null
          civil_status?: string | null
          created_at?: string
          currency?: string
          department_id?: string | null
          email?: string
          employee_number?: string
          employment_status?: Database["public"]["Enums"]["employment_status"]
          employment_type?: Database["public"]["Enums"]["employment_type"]
          first_name?: string
          gender?: string | null
          hire_date?: string
          id?: string
          last_name?: string
          middle_name?: string | null
          nationality?: string | null
          phone?: string | null
          photo_url?: string | null
          position_id?: string | null
          province?: string | null
          salary_grade_id?: string | null
          updated_at?: string
          work_schedule_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: true
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_salary_grade_id_fkey"
            columns: ["salary_grade_id"]
            isOneToOne: false
            referencedRelation: "salary_grades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_work_schedule_id_fkey"
            columns: ["work_schedule_id"]
            isOneToOne: false
            referencedRelation: "work_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      employment_contracts: {
        Row: {
          additional_notes: string | null
          company_policies: string | null
          contract_file_url: string | null
          created_at: string
          id: string
          job_offer_id: string
          signed_at: string | null
          signed_by: string | null
          signing_notes: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["contract_status"]
          terms: string | null
          updated_at: string
        }
        Insert: {
          additional_notes?: string | null
          company_policies?: string | null
          contract_file_url?: string | null
          created_at?: string
          id?: string
          job_offer_id: string
          signed_at?: string | null
          signed_by?: string | null
          signing_notes?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["contract_status"]
          terms?: string | null
          updated_at?: string
        }
        Update: {
          additional_notes?: string | null
          company_policies?: string | null
          contract_file_url?: string | null
          created_at?: string
          id?: string
          job_offer_id?: string
          signed_at?: string | null
          signed_by?: string | null
          signing_notes?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["contract_status"]
          terms?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employment_contracts_job_offer_id_fkey"
            columns: ["job_offer_id"]
            isOneToOne: false
            referencedRelation: "job_offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employment_contracts_signed_by_fkey"
            columns: ["signed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_accounts: {
        Row: {
          account_code: string | null
          account_subtype: string
          account_type: string
          created_at: string
          created_by: string | null
          currency: string
          id: string
          is_active: boolean
          name: string
          notes: string | null
          opening_balance: number
          opening_balance_as_of: string | null
          updated_at: string
        }
        Insert: {
          account_code?: string | null
          account_subtype: string
          account_type: string
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          opening_balance?: number
          opening_balance_as_of?: string | null
          updated_at?: string
        }
        Update: {
          account_code?: string | null
          account_subtype?: string
          account_type?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          opening_balance?: number
          opening_balance_as_of?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_accounts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_categories: {
        Row: {
          approval_status: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean
          kind: string
          name: string
          proposed_by: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          updated_at: string
        }
        Insert: {
          approval_status?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          kind: string
          name: string
          proposed_by?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          updated_at?: string
        }
        Update: {
          approval_status?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          kind?: string
          name?: string
          proposed_by?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_categories_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_categories_proposed_by_fkey"
            columns: ["proposed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_categories_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_privilege_grants: {
        Row: {
          closed_at: string | null
          closed_reason: string | null
          created_at: string
          finance_role: string
          granted_at: string
          granted_by: string | null
          id: string
          profile_id: string
          status: string
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_reason?: string | null
          created_at?: string
          finance_role: string
          granted_at?: string
          granted_by?: string | null
          id?: string
          profile_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_reason?: string | null
          created_at?: string
          finance_role?: string
          granted_at?: string
          granted_by?: string | null
          id?: string
          profile_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_privilege_grants_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_privilege_grants_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_request_approvals: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          from_status: string | null
          id: string
          remarks: string | null
          request_id: string
          role_at_action: string | null
          to_status: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          from_status?: string | null
          id?: string
          remarks?: string | null
          request_id: string
          role_at_action?: string | null
          to_status?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          from_status?: string | null
          id?: string
          remarks?: string | null
          request_id?: string
          role_at_action?: string | null
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finance_request_approvals_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_request_approvals_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "finance_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_request_attachments: {
        Row: {
          created_at: string
          file_name: string
          file_path: string
          file_size: number | null
          file_type: string | null
          id: string
          kind: string
          request_id: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          file_name: string
          file_path: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          kind?: string
          request_id: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          file_name?: string
          file_path?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          kind?: string
          request_id?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finance_request_attachments_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "finance_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_request_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_requests: {
        Row: {
          amount: number
          budget_id: string | null
          created_at: string
          delivery_branch_id: string | null
          department_id: string | null
          description: string | null
          expense_date: string | null
          finance_category_id: string | null
          id: string
          justification: string | null
          needed_by: string | null
          paid_at: string | null
          paid_from_account_id: string | null
          payment_reference: string | null
          priority: string
          request_no: string | null
          requester_id: string
          status: string
          title: string
          type: string
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          amount: number
          budget_id?: string | null
          created_at?: string
          delivery_branch_id?: string | null
          department_id?: string | null
          description?: string | null
          expense_date?: string | null
          finance_category_id?: string | null
          id?: string
          justification?: string | null
          needed_by?: string | null
          paid_at?: string | null
          paid_from_account_id?: string | null
          payment_reference?: string | null
          priority?: string
          request_no?: string | null
          requester_id: string
          status?: string
          title: string
          type: string
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          amount?: number
          budget_id?: string | null
          created_at?: string
          delivery_branch_id?: string | null
          department_id?: string | null
          description?: string | null
          expense_date?: string | null
          finance_category_id?: string | null
          id?: string
          justification?: string | null
          needed_by?: string | null
          paid_at?: string | null
          paid_from_account_id?: string | null
          payment_reference?: string | null
          priority?: string
          request_no?: string | null
          requester_id?: string
          status?: string
          title?: string
          type?: string
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finance_requests_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budget_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_requests_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budgets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_requests_delivery_branch_id_fkey"
            columns: ["delivery_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_requests_delivery_branch_id_fkey"
            columns: ["delivery_branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_requests_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_requests_finance_category_id_fkey"
            columns: ["finance_category_id"]
            isOneToOne: false
            referencedRelation: "finance_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_requests_paid_from_account_id_fkey"
            columns: ["paid_from_account_id"]
            isOneToOne: false
            referencedRelation: "finance_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_requests_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_requests_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      generated_reports: {
        Row: {
          created_at: string
          file_url: string | null
          filters: Json | null
          format: Database["public"]["Enums"]["report_format"]
          generated_by: string | null
          id: string
          report_type: string
        }
        Insert: {
          created_at?: string
          file_url?: string | null
          filters?: Json | null
          format: Database["public"]["Enums"]["report_format"]
          generated_by?: string | null
          id?: string
          report_type: string
        }
        Update: {
          created_at?: string
          file_url?: string | null
          filters?: Json | null
          format?: Database["public"]["Enums"]["report_format"]
          generated_by?: string | null
          id?: string
          report_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "generated_reports_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      hr_privilege_grants: {
        Row: {
          closed_at: string | null
          closed_reason: string | null
          created_at: string
          granted_at: string
          granted_by: string | null
          hr_role: string
          id: string
          profile_id: string
          status: string
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_reason?: string | null
          created_at?: string
          granted_at?: string
          granted_by?: string | null
          hr_role: string
          id?: string
          profile_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_reason?: string | null
          created_at?: string
          granted_at?: string
          granted_by?: string | null
          hr_role?: string
          id?: string
          profile_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hr_privilege_grants_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hr_privilege_grants_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      interviews: {
        Row: {
          application_id: string
          created_at: string
          final_remarks: string | null
          id: string
          interview_notes: string | null
          interview_type: Database["public"]["Enums"]["interview_type"]
          interviewer_id: string | null
          location: string | null
          meeting_link: string | null
          mode: string | null
          overall_impression: string | null
          rating_communication: number | null
          rating_confidence: number | null
          rating_culture_fit: number | null
          rating_experience: number | null
          rating_leadership: number | null
          rating_problem_solving: number | null
          rating_technical_evaluation: number | null
          rating_technical_skills: number | null
          recommended_salary: number | null
          rejection_reason: string | null
          remarks: string | null
          scheduled_at: string
          status: Database["public"]["Enums"]["interview_status"]
          updated_at: string
        }
        Insert: {
          application_id: string
          created_at?: string
          final_remarks?: string | null
          id?: string
          interview_notes?: string | null
          interview_type: Database["public"]["Enums"]["interview_type"]
          interviewer_id?: string | null
          location?: string | null
          meeting_link?: string | null
          mode?: string | null
          overall_impression?: string | null
          rating_communication?: number | null
          rating_confidence?: number | null
          rating_culture_fit?: number | null
          rating_experience?: number | null
          rating_leadership?: number | null
          rating_problem_solving?: number | null
          rating_technical_evaluation?: number | null
          rating_technical_skills?: number | null
          recommended_salary?: number | null
          rejection_reason?: string | null
          remarks?: string | null
          scheduled_at: string
          status?: Database["public"]["Enums"]["interview_status"]
          updated_at?: string
        }
        Update: {
          application_id?: string
          created_at?: string
          final_remarks?: string | null
          id?: string
          interview_notes?: string | null
          interview_type?: Database["public"]["Enums"]["interview_type"]
          interviewer_id?: string | null
          location?: string | null
          meeting_link?: string | null
          mode?: string | null
          overall_impression?: string | null
          rating_communication?: number | null
          rating_confidence?: number | null
          rating_culture_fit?: number | null
          rating_experience?: number | null
          rating_leadership?: number | null
          rating_problem_solving?: number | null
          rating_technical_evaluation?: number | null
          rating_technical_skills?: number | null
          recommended_salary?: number | null
          rejection_reason?: string | null
          remarks?: string | null
          scheduled_at?: string
          status?: Database["public"]["Enums"]["interview_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "interviews_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_interviewer_id_fkey"
            columns: ["interviewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_offers: {
        Row: {
          additional_compensation: string | null
          application_id: string
          benefits: string | null
          created_at: string
          currency: string
          decline_notes: string | null
          decline_reason: string | null
          employment_type: Database["public"]["Enums"]["employment_type"]
          id: string
          notes: string | null
          offer_date: string
          prepared_by: string | null
          proposed_salary: number
          responded_at: string | null
          salary_grade_id: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["offer_status"]
          updated_at: string
          work_schedule_id: string | null
          working_days: string | null
          working_hours: string | null
        }
        Insert: {
          additional_compensation?: string | null
          application_id: string
          benefits?: string | null
          created_at?: string
          currency?: string
          decline_notes?: string | null
          decline_reason?: string | null
          employment_type?: Database["public"]["Enums"]["employment_type"]
          id?: string
          notes?: string | null
          offer_date?: string
          prepared_by?: string | null
          proposed_salary: number
          responded_at?: string | null
          salary_grade_id?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["offer_status"]
          updated_at?: string
          work_schedule_id?: string | null
          working_days?: string | null
          working_hours?: string | null
        }
        Update: {
          additional_compensation?: string | null
          application_id?: string
          benefits?: string | null
          created_at?: string
          currency?: string
          decline_notes?: string | null
          decline_reason?: string | null
          employment_type?: Database["public"]["Enums"]["employment_type"]
          id?: string
          notes?: string | null
          offer_date?: string
          prepared_by?: string | null
          proposed_salary?: number
          responded_at?: string | null
          salary_grade_id?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["offer_status"]
          updated_at?: string
          work_schedule_id?: string | null
          working_days?: string | null
          working_hours?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_offers_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_offers_prepared_by_fkey"
            columns: ["prepared_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_offers_salary_grade_id_fkey"
            columns: ["salary_grade_id"]
            isOneToOne: false
            referencedRelation: "salary_grades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_offers_work_schedule_id_fkey"
            columns: ["work_schedule_id"]
            isOneToOne: false
            referencedRelation: "work_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      job_postings: {
        Row: {
          closing_date: string | null
          created_at: string
          date_posted: string | null
          department_id: string
          description: string
          employment_type: Database["public"]["Enums"]["employment_type"]
          id: string
          position_id: string
          posted_by: string | null
          requirements: string | null
          status: Database["public"]["Enums"]["job_posting_status"]
          updated_at: string
          vacancies: number
        }
        Insert: {
          closing_date?: string | null
          created_at?: string
          date_posted?: string | null
          department_id: string
          description: string
          employment_type?: Database["public"]["Enums"]["employment_type"]
          id?: string
          position_id: string
          posted_by?: string | null
          requirements?: string | null
          status?: Database["public"]["Enums"]["job_posting_status"]
          updated_at?: string
          vacancies?: number
        }
        Update: {
          closing_date?: string | null
          created_at?: string
          date_posted?: string | null
          department_id?: string
          description?: string
          employment_type?: Database["public"]["Enums"]["employment_type"]
          id?: string
          position_id?: string
          posted_by?: string | null
          requirements?: string | null
          status?: Database["public"]["Enums"]["job_posting_status"]
          updated_at?: string
          vacancies?: number
        }
        Relationships: [
          {
            foreignKeyName: "job_postings_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_postings_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_postings_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_balances: {
        Row: {
          employee_id: string
          id: string
          leave_type_id: string
          remaining_credits: number | null
          total_credits: number
          updated_at: string
          used_credits: number
          year: number
        }
        Insert: {
          employee_id: string
          id?: string
          leave_type_id: string
          remaining_credits?: number | null
          total_credits?: number
          updated_at?: string
          used_credits?: number
          year: number
        }
        Update: {
          employee_id?: string
          id?: string
          leave_type_id?: string
          remaining_credits?: number | null
          total_credits?: number
          updated_at?: string
          used_credits?: number
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "leave_balances_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_balances_leave_type_id_fkey"
            columns: ["leave_type_id"]
            isOneToOne: false
            referencedRelation: "leave_types"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_requests: {
        Row: {
          created_at: string
          days_requested: number
          employee_id: string
          end_date: string
          id: string
          leave_type_id: string
          reason: string | null
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          start_date: string
          status: Database["public"]["Enums"]["leave_request_status"]
          supporting_document_url: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          days_requested: number
          employee_id: string
          end_date: string
          id?: string
          leave_type_id: string
          reason?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          start_date: string
          status?: Database["public"]["Enums"]["leave_request_status"]
          supporting_document_url?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          days_requested?: number
          employee_id?: string
          end_date?: string
          id?: string
          leave_type_id?: string
          reason?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["leave_request_status"]
          supporting_document_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leave_requests_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_leave_type_id_fkey"
            columns: ["leave_type_id"]
            isOneToOne: false
            referencedRelation: "leave_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_types: {
        Row: {
          created_at: string
          default_credits: number
          id: string
          is_paid: boolean
          name: string
        }
        Insert: {
          created_at?: string
          default_credits?: number
          id?: string
          is_paid?: boolean
          name: string
        }
        Update: {
          created_at?: string
          default_credits?: number
          id?: string
          is_paid?: boolean
          name?: string
        }
        Relationships: []
      }
      payroll_line_items: {
        Row: {
          amount: number
          created_at: string
          id: string
          item_type: string
          label: string
          payroll_record_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          item_type: string
          label: string
          payroll_record_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          item_type?: string
          label?: string
          payroll_record_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payroll_line_items_payroll_record_id_fkey"
            columns: ["payroll_record_id"]
            isOneToOne: false
            referencedRelation: "payroll_records"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_periods: {
        Row: {
          created_at: string
          created_by: string | null
          frequency: string
          id: string
          pay_date: string | null
          period_end: string
          period_start: string
          status: Database["public"]["Enums"]["payroll_status"]
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          frequency?: string
          id?: string
          pay_date?: string | null
          period_end: string
          period_start: string
          status?: Database["public"]["Enums"]["payroll_status"]
        }
        Update: {
          created_at?: string
          created_by?: string | null
          frequency?: string
          id?: string
          pay_date?: string | null
          period_end?: string
          period_start?: string
          status?: Database["public"]["Enums"]["payroll_status"]
        }
        Relationships: [
          {
            foreignKeyName: "payroll_periods_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_records: {
        Row: {
          absent_days: number
          basic_salary: number
          created_at: string
          currency: string
          days_present: number
          employee_id: string
          gross_salary: number
          id: string
          late_deduction: number
          late_minutes: number
          leave_deduction: number
          net_salary: number
          notes: string | null
          other_deductions: number
          overtime_hours: number
          overtime_pay: number
          pagibig_contribution: number
          paid_leave_days: number
          payroll_period_id: string
          philhealth_contribution: number
          rejection_reason: string | null
          released_at: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          sss_contribution: number
          status: Database["public"]["Enums"]["payroll_status"]
          submitted_at: string | null
          submitted_by: string | null
          total_allowances: number
          total_deductions: number
          undertime_deduction: number
          undertime_minutes: number
          unpaid_leave_days: number
          updated_at: string
          working_days: number
        }
        Insert: {
          absent_days?: number
          basic_salary?: number
          created_at?: string
          currency?: string
          days_present?: number
          employee_id: string
          gross_salary?: number
          id?: string
          late_deduction?: number
          late_minutes?: number
          leave_deduction?: number
          net_salary?: number
          notes?: string | null
          other_deductions?: number
          overtime_hours?: number
          overtime_pay?: number
          pagibig_contribution?: number
          paid_leave_days?: number
          payroll_period_id: string
          philhealth_contribution?: number
          rejection_reason?: string | null
          released_at?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sss_contribution?: number
          status?: Database["public"]["Enums"]["payroll_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          total_allowances?: number
          total_deductions?: number
          undertime_deduction?: number
          undertime_minutes?: number
          unpaid_leave_days?: number
          updated_at?: string
          working_days?: number
        }
        Update: {
          absent_days?: number
          basic_salary?: number
          created_at?: string
          currency?: string
          days_present?: number
          employee_id?: string
          gross_salary?: number
          id?: string
          late_deduction?: number
          late_minutes?: number
          leave_deduction?: number
          net_salary?: number
          notes?: string | null
          other_deductions?: number
          overtime_hours?: number
          overtime_pay?: number
          pagibig_contribution?: number
          paid_leave_days?: number
          payroll_period_id?: string
          philhealth_contribution?: number
          rejection_reason?: string | null
          released_at?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sss_contribution?: number
          status?: Database["public"]["Enums"]["payroll_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          total_allowances?: number
          total_deductions?: number
          undertime_deduction?: number
          undertime_minutes?: number
          unpaid_leave_days?: number
          updated_at?: string
          working_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "payroll_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_records_payroll_period_id_fkey"
            columns: ["payroll_period_id"]
            isOneToOne: false
            referencedRelation: "payroll_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_records_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_records_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payslips: {
        Row: {
          created_at: string
          file_url: string | null
          id: string
          payroll_record_id: string
          payslip_number: string
          released_at: string | null
        }
        Insert: {
          created_at?: string
          file_url?: string | null
          id?: string
          payroll_record_id: string
          payslip_number?: string
          released_at?: string | null
        }
        Update: {
          created_at?: string
          file_url?: string | null
          id?: string
          payroll_record_id?: string
          payslip_number?: string
          released_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payslips_payroll_record_id_fkey"
            columns: ["payroll_record_id"]
            isOneToOne: false
            referencedRelation: "payroll_records"
            referencedColumns: ["id"]
          },
        ]
      }
      ph_locations: {
        Row: {
          code: string | null
          created_at: string
          id: string
          level: string
          name: string
          parent_id: string | null
        }
        Insert: {
          code?: string | null
          created_at?: string
          id?: string
          level: string
          name: string
          parent_id?: string | null
        }
        Update: {
          code?: string | null
          created_at?: string
          id?: string
          level?: string
          name?: string
          parent_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ph_locations_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "ph_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_audit_events: {
        Row: {
          actor_enterprise_role: Database["public"]["Enums"]["user_role"]
          actor_id: string
          actor_name_snapshot: string
          actor_pos_role: Database["public"]["Enums"]["pos_role"] | null
          admin_description: string
          admin_new_value: string | null
          admin_old_value: string | null
          branch_id: string | null
          branch_name_snapshot: string | null
          created_at: string
          entity_id: string | null
          entity_name_snapshot: string | null
          entity_type: Database["public"]["Enums"]["pos_audit_entity_type"]
          event_type: Database["public"]["Enums"]["pos_audit_event_type"]
          id: string
          manager_visible: boolean
          safe_new_value: string | null
          safe_old_value: string | null
        }
        Insert: {
          actor_enterprise_role: Database["public"]["Enums"]["user_role"]
          actor_id: string
          actor_name_snapshot: string
          actor_pos_role?: Database["public"]["Enums"]["pos_role"] | null
          admin_description: string
          admin_new_value?: string | null
          admin_old_value?: string | null
          branch_id?: string | null
          branch_name_snapshot?: string | null
          created_at?: string
          entity_id?: string | null
          entity_name_snapshot?: string | null
          entity_type: Database["public"]["Enums"]["pos_audit_entity_type"]
          event_type: Database["public"]["Enums"]["pos_audit_event_type"]
          id?: string
          manager_visible: boolean
          safe_new_value?: string | null
          safe_old_value?: string | null
        }
        Update: {
          actor_enterprise_role?: Database["public"]["Enums"]["user_role"]
          actor_id?: string
          actor_name_snapshot?: string
          actor_pos_role?: Database["public"]["Enums"]["pos_role"] | null
          admin_description?: string
          admin_new_value?: string | null
          admin_old_value?: string | null
          branch_id?: string | null
          branch_name_snapshot?: string | null
          created_at?: string
          entity_id?: string | null
          entity_name_snapshot?: string | null
          entity_type?: Database["public"]["Enums"]["pos_audit_entity_type"]
          event_type?: Database["public"]["Enums"]["pos_audit_event_type"]
          id?: string
          manager_visible?: boolean
          safe_new_value?: string | null
          safe_old_value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_audit_events_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_audit_events_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_branch_assignments: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          id: string
          pos_role: Database["public"]["Enums"]["pos_role"]
          profile_id: string
          revoked_reason: string | null
          status: Database["public"]["Enums"]["account_status"]
          updated_at: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          pos_role: Database["public"]["Enums"]["pos_role"]
          profile_id: string
          revoked_reason?: string | null
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          pos_role?: Database["public"]["Enums"]["pos_role"]
          profile_id?: string
          revoked_reason?: string | null
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_branch_assignments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_branch_assignments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_branch_assignments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_branch_assignments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_branch_inventory: {
        Row: {
          average_unit_cost: number
          branch_id: string
          created_at: string
          low_stock_threshold: number
          product_id: string
          quantity_on_hand: number
          updated_at: string
        }
        Insert: {
          average_unit_cost?: number
          branch_id: string
          created_at?: string
          low_stock_threshold?: number
          product_id: string
          quantity_on_hand?: number
          updated_at?: string
        }
        Update: {
          average_unit_cost?: number
          branch_id?: string
          created_at?: string
          low_stock_threshold?: number
          product_id?: string
          quantity_on_hand?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_branch_inventory_branch_product_fk"
            columns: ["branch_id", "product_id"]
            isOneToOne: true
            referencedRelation: "pos_branch_products"
            referencedColumns: ["branch_id", "product_id"]
          },
        ]
      }
      pos_branch_products: {
        Row: {
          branch_id: string
          created_at: string
          is_available: boolean
          product_id: string
          selling_price_override: number | null
          updated_at: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          is_available?: boolean
          product_id: string
          selling_price_override?: number | null
          updated_at?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          is_available?: boolean
          product_id?: string
          selling_price_override?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_branch_products_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_branch_products_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_branch_products_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "pos_products"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_inventory_movements: {
        Row: {
          actor_id: string | null
          branch_id: string
          created_at: string
          id: string
          movement_type: Database["public"]["Enums"]["pos_movement_type"]
          notes: string | null
          product_id: string
          quantity_change: number
          source_id: string | null
          source_type: string
          stock_after: number
          stock_before: number
          unit_cost: number | null
        }
        Insert: {
          actor_id?: string | null
          branch_id: string
          created_at?: string
          id?: string
          movement_type: Database["public"]["Enums"]["pos_movement_type"]
          notes?: string | null
          product_id: string
          quantity_change: number
          source_id?: string | null
          source_type: string
          stock_after: number
          stock_before: number
          unit_cost?: number | null
        }
        Update: {
          actor_id?: string | null
          branch_id?: string
          created_at?: string
          id?: string
          movement_type?: Database["public"]["Enums"]["pos_movement_type"]
          notes?: string | null
          product_id?: string
          quantity_change?: number
          source_id?: string | null
          source_type?: string
          stock_after?: number
          stock_before?: number
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_inventory_movements_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_inventory_movements_inventory_fk"
            columns: ["branch_id", "product_id"]
            isOneToOne: false
            referencedRelation: "pos_branch_inventory"
            referencedColumns: ["branch_id", "product_id"]
          },
        ]
      }
      pos_inventory_requests: {
        Row: {
          branch_id: string
          branch_name_snapshot: string
          created_at: string
          id: string
          product_id: string | null
          product_name_snapshot: string
          proposed_category_id: string | null
          proposed_description: string | null
          proposed_selling_price: number | null
          reason: string
          request_type: Database["public"]["Enums"]["pos_request_type"]
          requested_at: string
          requested_by: string
          requested_quantity: number | null
          requester_name_snapshot: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          reviewer_name_snapshot: string | null
          status: Database["public"]["Enums"]["pos_request_status"]
          updated_at: string
        }
        Insert: {
          branch_id: string
          branch_name_snapshot: string
          created_at?: string
          id?: string
          product_id?: string | null
          product_name_snapshot: string
          proposed_category_id?: string | null
          proposed_description?: string | null
          proposed_selling_price?: number | null
          reason: string
          request_type: Database["public"]["Enums"]["pos_request_type"]
          requested_at?: string
          requested_by: string
          requested_quantity?: number | null
          requester_name_snapshot: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_name_snapshot?: string | null
          status?: Database["public"]["Enums"]["pos_request_status"]
          updated_at?: string
        }
        Update: {
          branch_id?: string
          branch_name_snapshot?: string
          created_at?: string
          id?: string
          product_id?: string | null
          product_name_snapshot?: string
          proposed_category_id?: string | null
          proposed_description?: string | null
          proposed_selling_price?: number | null
          reason?: string
          request_type?: Database["public"]["Enums"]["pos_request_type"]
          requested_at?: string
          requested_by?: string
          requested_quantity?: number | null
          requester_name_snapshot?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_name_snapshot?: string | null
          status?: Database["public"]["Enums"]["pos_request_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_inventory_requests_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_inventory_requests_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_inventory_requests_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "pos_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_inventory_requests_proposed_category_id_fkey"
            columns: ["proposed_category_id"]
            isOneToOne: false
            referencedRelation: "pos_product_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_payment_attempts: {
        Row: {
          amount_centavos: number
          branch_id: string
          cancelled_at: string | null
          cashier_profile_id: string
          checkout_key: string
          checkout_url: string | null
          created_at: string
          currency: string
          expires_at: string | null
          failed_at: string | null
          id: string
          items: Json
          last_error: string | null
          livemode: boolean
          method: string
          paid_at: string | null
          provider: string
          provider_checkout_session_id: string | null
          provider_payment_id: string | null
          provider_payment_intent_id: string | null
          reference_number: string
          sale_id: string | null
          status: Database["public"]["Enums"]["pos_payment_status"]
          updated_at: string
        }
        Insert: {
          amount_centavos: number
          branch_id: string
          cancelled_at?: string | null
          cashier_profile_id: string
          checkout_key: string
          checkout_url?: string | null
          created_at?: string
          currency?: string
          expires_at?: string | null
          failed_at?: string | null
          id?: string
          items: Json
          last_error?: string | null
          livemode?: boolean
          method: string
          paid_at?: string | null
          provider?: string
          provider_checkout_session_id?: string | null
          provider_payment_id?: string | null
          provider_payment_intent_id?: string | null
          reference_number: string
          sale_id?: string | null
          status?: Database["public"]["Enums"]["pos_payment_status"]
          updated_at?: string
        }
        Update: {
          amount_centavos?: number
          branch_id?: string
          cancelled_at?: string | null
          cashier_profile_id?: string
          checkout_key?: string
          checkout_url?: string | null
          created_at?: string
          currency?: string
          expires_at?: string | null
          failed_at?: string | null
          id?: string
          items?: Json
          last_error?: string | null
          livemode?: boolean
          method?: string
          paid_at?: string | null
          provider?: string
          provider_checkout_session_id?: string | null
          provider_payment_id?: string | null
          provider_payment_intent_id?: string | null
          reference_number?: string
          sale_id?: string | null
          status?: Database["public"]["Enums"]["pos_payment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_payment_attempts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payment_attempts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payment_attempts_cashier_profile_id_fkey"
            columns: ["cashier_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payment_attempts_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "pos_sales"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_product_categories: {
        Row: {
          color: string | null
          created_at: string
          created_by: string | null
          description: string | null
          icon: string | null
          id: string
          is_active: boolean
          name: string
          normalized_name: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name: string
          normalized_name?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name?: string
          normalized_name?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_product_categories_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_products: {
        Row: {
          category_id: string
          created_at: string
          created_by: string | null
          default_selling_price: number
          default_unit_cost: number
          id: string
          image_path: string | null
          name: string
          normalized_name: string | null
          status: Database["public"]["Enums"]["pos_product_status"]
          updated_at: string
        }
        Insert: {
          category_id: string
          created_at?: string
          created_by?: string | null
          default_selling_price?: number
          default_unit_cost?: number
          id?: string
          image_path?: string | null
          name: string
          normalized_name?: string | null
          status?: Database["public"]["Enums"]["pos_product_status"]
          updated_at?: string
        }
        Update: {
          category_id?: string
          created_at?: string
          created_by?: string | null
          default_selling_price?: number
          default_unit_cost?: number
          id?: string
          image_path?: string | null
          name?: string
          normalized_name?: string | null
          status?: Database["public"]["Enums"]["pos_product_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "pos_product_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_products_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_sale_items: {
        Row: {
          category_name: string
          created_at: string
          id: string
          line_cogs: number
          line_total: number
          product_id: string
          product_name: string
          quantity: number
          sale_id: string
          unit_cost_snapshot: number
          unit_price: number
        }
        Insert: {
          category_name: string
          created_at?: string
          id?: string
          line_cogs: number
          line_total: number
          product_id: string
          product_name: string
          quantity: number
          sale_id: string
          unit_cost_snapshot: number
          unit_price: number
        }
        Update: {
          category_name?: string
          created_at?: string
          id?: string
          line_cogs?: number
          line_total?: number
          product_id?: string
          product_name?: string
          quantity?: number
          sale_id?: string
          unit_cost_snapshot?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "pos_sale_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "pos_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_sale_items_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "pos_sales"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_sales: {
        Row: {
          amount_tendered: number | null
          branch_address: string | null
          branch_id: string
          branch_name: string
          branch_phone: string | null
          cashier_id: string
          cashier_name: string
          change_given: number | null
          checkout_key: string
          company_name: string | null
          created_at: string
          fees: Json
          fees_total: number
          id: string
          payment_method: string
          payment_reference: string | null
          request_fingerprint: string
          status: Database["public"]["Enums"]["pos_sale_status"]
          subtotal: number
          total_amount: number
          total_cogs: number
        }
        Insert: {
          amount_tendered?: number | null
          branch_address?: string | null
          branch_id: string
          branch_name: string
          branch_phone?: string | null
          cashier_id: string
          cashier_name: string
          change_given?: number | null
          checkout_key: string
          company_name?: string | null
          created_at?: string
          fees?: Json
          fees_total?: number
          id?: string
          payment_method: string
          payment_reference?: string | null
          request_fingerprint: string
          status?: Database["public"]["Enums"]["pos_sale_status"]
          subtotal: number
          total_amount: number
          total_cogs?: number
        }
        Update: {
          amount_tendered?: number | null
          branch_address?: string | null
          branch_id?: string
          branch_name?: string
          branch_phone?: string | null
          cashier_id?: string
          cashier_name?: string
          change_given?: number | null
          checkout_key?: string
          company_name?: string | null
          created_at?: string
          fees?: Json
          fees_total?: number
          id?: string
          payment_method?: string
          payment_reference?: string | null
          request_fingerprint?: string
          status?: Database["public"]["Enums"]["pos_sale_status"]
          subtotal?: number
          total_amount?: number
          total_cogs?: number
        }
        Relationships: [
          {
            foreignKeyName: "pos_sales_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_sales_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_sales_cashier_id_fkey"
            columns: ["cashier_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      position_system_roles: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          position_id: string
          role_code: string
          system: Database["public"]["Enums"]["entitlement_system"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          position_id: string
          role_code: string
          system: Database["public"]["Enums"]["entitlement_system"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          position_id?: string
          role_code?: string
          system?: Database["public"]["Enums"]["entitlement_system"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "position_system_roles_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          created_at: string
          department_id: string
          description: string | null
          id: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          department_id: string
          description?: string | null
          id?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          department_id?: string
          description?: string | null
          id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      procurement_receipts: {
        Row: {
          created_at: string
          delivery_reference: string | null
          id: string
          idempotency_key: string
          inventory_movement_id: string | null
          purchase_order_item_id: string
          quantity_received: number
          received_at: string
          received_by: string | null
        }
        Insert: {
          created_at?: string
          delivery_reference?: string | null
          id?: string
          idempotency_key: string
          inventory_movement_id?: string | null
          purchase_order_item_id: string
          quantity_received: number
          received_at?: string
          received_by?: string | null
        }
        Update: {
          created_at?: string
          delivery_reference?: string | null
          id?: string
          idempotency_key?: string
          inventory_movement_id?: string | null
          purchase_order_item_id?: string
          quantity_received?: number
          received_at?: string
          received_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "procurement_receipts_inventory_movement_id_fkey"
            columns: ["inventory_movement_id"]
            isOneToOne: false
            referencedRelation: "pos_inventory_movements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "procurement_receipts_purchase_order_item_id_fkey"
            columns: ["purchase_order_item_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "procurement_receipts_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          activated_at: string | null
          avatar_url: string | null
          created_at: string
          created_by: string | null
          email: string
          employee_id: string | null
          full_name: string
          id: string
          invited_at: string | null
          last_login_at: string | null
          role: Database["public"]["Enums"]["user_role"]
          status: Database["public"]["Enums"]["account_status"]
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          avatar_url?: string | null
          created_at?: string
          created_by?: string | null
          email: string
          employee_id?: string | null
          full_name: string
          id: string
          invited_at?: string | null
          last_login_at?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          avatar_url?: string | null
          created_at?: string
          created_by?: string | null
          email?: string
          employee_id?: string | null
          full_name?: string
          id?: string
          invited_at?: string | null
          last_login_at?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_profiles_employee"
            columns: ["employee_id"]
            isOneToOne: true
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_items: {
        Row: {
          created_at: string
          description: string
          destination_branch_id: string | null
          id: string
          line_total: number | null
          pos_product_id: string | null
          purchase_order_id: string
          quantity_cancelled: number
          quantity_ordered: number
          unit_cost: number
          unit_of_measure: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description: string
          destination_branch_id?: string | null
          id?: string
          line_total?: number | null
          pos_product_id?: string | null
          purchase_order_id: string
          quantity_cancelled?: number
          quantity_ordered: number
          unit_cost: number
          unit_of_measure?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string
          destination_branch_id?: string | null
          id?: string
          line_total?: number | null
          pos_product_id?: string | null
          purchase_order_id?: string
          quantity_cancelled?: number
          quantity_ordered?: number
          unit_cost?: number
          unit_of_measure?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_items_destination_branch_id_fkey"
            columns: ["destination_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_destination_branch_id_fkey"
            columns: ["destination_branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_pos_product_id_fkey"
            columns: ["pos_product_id"]
            isOneToOne: false
            referencedRelation: "pos_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_sources: {
        Row: {
          created_at: string
          created_by: string | null
          finance_request_id: string | null
          id: string
          pos_inventory_request_id: string | null
          purchase_order_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          finance_request_id?: string | null
          id?: string
          pos_inventory_request_id?: string | null
          purchase_order_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          finance_request_id?: string | null
          id?: string
          pos_inventory_request_id?: string | null
          purchase_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_sources_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_sources_finance_request_id_fkey"
            columns: ["finance_request_id"]
            isOneToOne: false
            referencedRelation: "finance_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_sources_pos_inventory_request_id_fkey"
            columns: ["pos_inventory_request_id"]
            isOneToOne: false
            referencedRelation: "pos_inventory_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_sources_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_sources_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          budget_id: string | null
          closed_at: string | null
          closed_reason: string | null
          created_at: string
          created_by: string | null
          currency: string
          delivery_branch_id: string | null
          expected_delivery_date: string | null
          id: string
          notes: string | null
          order_date: string | null
          po_number: string | null
          status: string
          submitted_at: string | null
          updated_at: string
          vendor_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          budget_id?: string | null
          closed_at?: string | null
          closed_reason?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          delivery_branch_id?: string | null
          expected_delivery_date?: string | null
          id?: string
          notes?: string | null
          order_date?: string | null
          po_number?: string | null
          status?: string
          submitted_at?: string | null
          updated_at?: string
          vendor_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          budget_id?: string | null
          closed_at?: string | null
          closed_reason?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          delivery_branch_id?: string | null
          expected_delivery_date?: string | null
          id?: string
          notes?: string | null
          order_date?: string | null
          po_number?: string | null
          status?: string
          submitted_at?: string | null
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budget_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budgets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_delivery_branch_id_fkey"
            columns: ["delivery_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_delivery_branch_id_fkey"
            columns: ["delivery_branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      salary_grades: {
        Row: {
          created_at: string
          employment_type: Database["public"]["Enums"]["employment_type"]
          grade_name: string
          id: string
          max_salary: number
          min_salary: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          employment_type?: Database["public"]["Enums"]["employment_type"]
          grade_name: string
          id?: string
          max_salary: number
          min_salary: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          employment_type?: Database["public"]["Enums"]["employment_type"]
          grade_name?: string
          id?: string
          max_salary?: number
          min_salary?: number
          updated_at?: string
        }
        Relationships: []
      }
      supplier_invoice_history: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          from_status: string | null
          id: string
          remarks: string | null
          role_at_action: string | null
          supplier_invoice_id: string
          to_status: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          from_status?: string | null
          id?: string
          remarks?: string | null
          role_at_action?: string | null
          supplier_invoice_id: string
          to_status?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          from_status?: string | null
          id?: string
          remarks?: string | null
          role_at_action?: string | null
          supplier_invoice_id?: string
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "supplier_invoice_history_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoice_history_supplier_invoice_id_fkey"
            columns: ["supplier_invoice_id"]
            isOneToOne: false
            referencedRelation: "supplier_invoice_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoice_history_supplier_invoice_id_fkey"
            columns: ["supplier_invoice_id"]
            isOneToOne: false
            referencedRelation: "supplier_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_invoice_lines: {
        Row: {
          created_at: string
          description: string
          id: string
          line_total: number | null
          purchase_order_item_id: string
          quantity: number
          supplier_invoice_id: string
          unit_cost: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          line_total?: number | null
          purchase_order_item_id: string
          quantity: number
          supplier_invoice_id: string
          unit_cost: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          line_total?: number | null
          purchase_order_item_id?: string
          quantity?: number
          supplier_invoice_id?: string
          unit_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "supplier_invoice_lines_purchase_order_item_id_fkey"
            columns: ["purchase_order_item_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoice_lines_supplier_invoice_id_fkey"
            columns: ["supplier_invoice_id"]
            isOneToOne: false
            referencedRelation: "supplier_invoice_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoice_lines_supplier_invoice_id_fkey"
            columns: ["supplier_invoice_id"]
            isOneToOne: false
            referencedRelation: "supplier_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_invoices: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          created_by: string | null
          currency: string
          decision_reason: string | null
          due_date: string | null
          id: string
          invoice_date: string
          invoice_no: string | null
          notes: string | null
          other_charges: number
          other_charges_note: string | null
          purchase_order_id: string
          status: string
          submitted_at: string | null
          supplier_invoice_number: string
          tax_amount: number
          updated_at: string
          vendor_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          decision_reason?: string | null
          due_date?: string | null
          id?: string
          invoice_date: string
          invoice_no?: string | null
          notes?: string | null
          other_charges?: number
          other_charges_note?: string | null
          purchase_order_id: string
          status?: string
          submitted_at?: string | null
          supplier_invoice_number: string
          tax_amount?: number
          updated_at?: string
          vendor_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          decision_reason?: string | null
          due_date?: string | null
          id?: string
          invoice_date?: string
          invoice_no?: string | null
          notes?: string | null
          other_charges?: number
          other_charges_note?: string | null
          purchase_order_id?: string
          status?: string
          submitted_at?: string | null
          supplier_invoice_number?: string
          tax_amount?: number
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_invoices_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoices_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoices_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoices_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_payments: {
        Row: {
          amount: number
          approved_at: string | null
          approved_by: string | null
          created_at: string
          decision_reason: string | null
          id: string
          method: string
          notes: string | null
          paid_at: string | null
          paid_by: string | null
          payment_date: string | null
          payment_no: string | null
          prepared_by: string | null
          reference: string | null
          status: string
          submitted_at: string | null
          supplier_invoice_id: string
          treasury_account_id: string
          updated_at: string
        }
        Insert: {
          amount: number
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          decision_reason?: string | null
          id?: string
          method: string
          notes?: string | null
          paid_at?: string | null
          paid_by?: string | null
          payment_date?: string | null
          payment_no?: string | null
          prepared_by?: string | null
          reference?: string | null
          status?: string
          submitted_at?: string | null
          supplier_invoice_id: string
          treasury_account_id: string
          updated_at?: string
        }
        Update: {
          amount?: number
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          decision_reason?: string | null
          id?: string
          method?: string
          notes?: string | null
          paid_at?: string | null
          paid_by?: string | null
          payment_date?: string | null
          payment_no?: string | null
          prepared_by?: string | null
          reference?: string | null
          status?: string
          submitted_at?: string | null
          supplier_invoice_id?: string
          treasury_account_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_payments_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_paid_by_fkey"
            columns: ["paid_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_prepared_by_fkey"
            columns: ["prepared_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_supplier_invoice_id_fkey"
            columns: ["supplier_invoice_id"]
            isOneToOne: false
            referencedRelation: "supplier_invoice_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_supplier_invoice_id_fkey"
            columns: ["supplier_invoice_id"]
            isOneToOne: false
            referencedRelation: "supplier_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_treasury_account_id_fkey"
            columns: ["treasury_account_id"]
            isOneToOne: false
            referencedRelation: "treasury_account_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_treasury_account_id_fkey"
            columns: ["treasury_account_id"]
            isOneToOne: false
            referencedRelation: "treasury_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      system_settings: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "system_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      treasury_accounts: {
        Row: {
          account_type: string
          branch_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          finance_account_id: string | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          opening_balance: number
          opening_balance_as_of: string | null
          updated_at: string
        }
        Insert: {
          account_type: string
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          finance_account_id?: string | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          opening_balance?: number
          opening_balance_as_of?: string | null
          updated_at?: string
        }
        Update: {
          account_type?: string
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          finance_account_id?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          opening_balance?: number
          opening_balance_as_of?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "treasury_accounts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "treasury_accounts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "treasury_accounts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "treasury_accounts_finance_account_id_fkey"
            columns: ["finance_account_id"]
            isOneToOne: false
            referencedRelation: "finance_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      treasury_movements: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          direction: string
          id: string
          occurred_on: string
          reference: string | null
          source_id: string
          source_type: string
          treasury_account_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          direction: string
          id?: string
          occurred_on: string
          reference?: string | null
          source_id: string
          source_type: string
          treasury_account_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          direction?: string
          id?: string
          occurred_on?: string
          reference?: string | null
          source_id?: string
          source_type?: string
          treasury_account_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "treasury_movements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "treasury_movements_treasury_account_id_fkey"
            columns: ["treasury_account_id"]
            isOneToOne: false
            referencedRelation: "treasury_account_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "treasury_movements_treasury_account_id_fkey"
            columns: ["treasury_account_id"]
            isOneToOne: false
            referencedRelation: "treasury_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_categories: {
        Row: {
          created_at: string
          created_by: string | null
          finance_category_id: string
          vendor_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          finance_category_id: string
          vendor_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          finance_category_id?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_categories_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_categories_finance_category_id_fkey"
            columns: ["finance_category_id"]
            isOneToOne: false
            referencedRelation: "finance_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_categories_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          address: string | null
          approval_status: string
          contact_person: string | null
          created_at: string
          created_by: string | null
          email: string | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          phone: string | null
          proposed_by: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          tin: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          approval_status?: string
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          phone?: string | null
          proposed_by?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          tin?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          approval_status?: string
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          phone?: string | null
          proposed_by?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          tin?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendors_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendors_proposed_by_fkey"
            columns: ["proposed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendors_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      work_locations: {
        Row: {
          branch_id: string | null
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          branch_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          branch_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_locations_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_locations_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      work_schedules: {
        Row: {
          break_minutes: number
          created_at: string
          employment_type: Database["public"]["Enums"]["employment_type"]
          end_time: string
          id: string
          is_default: boolean
          name: string
          start_time: string
          updated_at: string
          working_days: number[]
        }
        Insert: {
          break_minutes?: number
          created_at?: string
          employment_type?: Database["public"]["Enums"]["employment_type"]
          end_time: string
          id?: string
          is_default?: boolean
          name: string
          start_time: string
          updated_at?: string
          working_days?: number[]
        }
        Update: {
          break_minutes?: number
          created_at?: string
          employment_type?: Database["public"]["Enums"]["employment_type"]
          end_time?: string
          id?: string
          is_default?: boolean
          name?: string
          start_time?: string
          updated_at?: string
          working_days?: number[]
        }
        Relationships: []
      }
    }
    Views: {
      applicant_notification_latency: {
        Row: {
          attempts: number | null
          event_type: string | null
          id: string | null
          next_attempt_at: string | null
          provider_accepted: boolean | null
          provider_seconds: number | null
          queue_seconds: number | null
          queued_at: string | null
          sent_at: string | null
          status:
            | Database["public"]["Enums"]["applicant_notification_status"]
            | null
          total_seconds: number | null
          updated_at: string | null
          worker_started_at: string | null
        }
        Insert: {
          attempts?: number | null
          event_type?: string | null
          id?: string | null
          next_attempt_at?: string | null
          provider_accepted?: never
          provider_seconds?: never
          queue_seconds?: never
          queued_at?: string | null
          sent_at?: string | null
          status?:
            | Database["public"]["Enums"]["applicant_notification_status"]
            | null
          total_seconds?: never
          updated_at?: string | null
          worker_started_at?: string | null
        }
        Update: {
          attempts?: number | null
          event_type?: string | null
          id?: string | null
          next_attempt_at?: string | null
          provider_accepted?: never
          provider_seconds?: never
          queue_seconds?: never
          queued_at?: string | null
          sent_at?: string | null
          status?:
            | Database["public"]["Enums"]["applicant_notification_status"]
            | null
          total_seconds?: never
          updated_at?: string | null
          worker_started_at?: string | null
        }
        Relationships: []
      }
      budget_status: {
        Row: {
          alert_threshold: number | null
          allocated: number | null
          allocated_pct: number | null
          amount: number | null
          approved_at: string | null
          approved_by: string | null
          created_at: string | null
          created_by: string | null
          department_id: string | null
          department_name: string | null
          end_date: string | null
          finance_category_id: string | null
          finance_category_name: string | null
          fiscal_year: number | null
          id: string | null
          name: string | null
          period: string | null
          remaining: number | null
          reserved: number | null
          spent: number | null
          start_date: string | null
          status: string | null
          unallocated: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "budgets_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budgets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budgets_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budgets_finance_category_id_fkey"
            columns: ["finance_category_id"]
            isOneToOne: false
            referencedRelation: "finance_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_settlement_status: {
        Row: {
          branch_id: string | null
          branch_name: string | null
          created_at: string | null
          decision_reason: string | null
          destination_account_id: string | null
          destination_account_name: string | null
          destination_account_type: string | null
          fee_amount: number | null
          gross_amount: number | null
          id: string | null
          item_count: number | null
          kind: string | null
          net_amount: number | null
          notes: string | null
          payment_method: string | null
          prepared_by: string | null
          prepared_by_name: string | null
          reference: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          reviewed_by_name: string | null
          settlement_date: string | null
          settlement_no: string | null
          status: string | null
          submitted_at: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "collection_settlements_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlements_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlements_destination_account_id_fkey"
            columns: ["destination_account_id"]
            isOneToOne: false
            referencedRelation: "treasury_account_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlements_destination_account_id_fkey"
            columns: ["destination_account_id"]
            isOneToOne: false
            referencedRelation: "treasury_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlements_prepared_by_fkey"
            columns: ["prepared_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_settlements_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      public_branch_locations: {
        Row: {
          address: string | null
          id: string | null
          latitude: number | null
          longitude: number | null
          name: string | null
        }
        Insert: {
          address?: string | null
          id?: string | null
          latitude?: number | null
          longitude?: number | null
          name?: string | null
        }
        Update: {
          address?: string | null
          id?: string | null
          latitude?: number | null
          longitude?: number | null
          name?: string | null
        }
        Relationships: []
      }
      purchase_order_status: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          budget_id: string | null
          budget_name: string | null
          committed_amount: number | null
          created_at: string | null
          created_by: string | null
          expected_delivery_date: string | null
          id: string | null
          line_count: number | null
          notes: string | null
          order_date: string | null
          po_number: string | null
          quantity_cancelled: number | null
          quantity_ordered: number | null
          quantity_outstanding: number | null
          quantity_received: number | null
          status: string | null
          submitted_at: string | null
          subtotal: number | null
          updated_at: string | null
          vendor_id: string | null
          vendor_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budget_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budgets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_invoice_status: {
        Row: {
          amount_paid: number | null
          approved_at: string | null
          approved_by: string | null
          available_to_prepare: number | null
          balance_due: number | null
          created_at: string | null
          created_by: string | null
          currency: string | null
          days_until_due: number | null
          decision_reason: string | null
          due_date: string | null
          id: string | null
          invoice_date: string | null
          invoice_no: string | null
          line_count: number | null
          notes: string | null
          other_charges: number | null
          other_charges_note: string | null
          payment_state: string | null
          pending_payment_amount: number | null
          po_number: string | null
          purchase_order_id: string | null
          purchase_order_status: string | null
          settlement_state: string | null
          status: string | null
          submitted_at: string | null
          subtotal: number | null
          supplier_invoice_number: string | null
          tax_amount: number | null
          total_amount: number | null
          updated_at: string | null
          vendor_id: string | null
          vendor_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "supplier_invoices_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoices_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoices_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_invoices_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      treasury_account_status: {
        Row: {
          account_type: string | null
          balance: number | null
          branch_id: string | null
          branch_name: string | null
          created_at: string | null
          created_by: string | null
          currency: string | null
          finance_account_id: string | null
          finance_account_name: string | null
          id: string | null
          is_active: boolean | null
          last_movement_on: string | null
          movement_count: number | null
          name: string | null
          notes: string | null
          opening_balance: number | null
          opening_balance_as_of: string | null
          total_in: number | null
          total_out: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "treasury_accounts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "treasury_accounts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "public_branch_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "treasury_accounts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "treasury_accounts_finance_account_id_fkey"
            columns: ["finance_account_id"]
            isOneToOne: false
            referencedRelation: "finance_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      add_pos_product_to_branch: {
        Args: { _branch_id: string; _product_id: string }
        Returns: string
      }
      adjust_pos_stock: {
        Args: {
          _branch_id: string
          _notes?: string
          _product_id: string
          _quantity_change: number
          _reason: string
        }
        Returns: {
          average_unit_cost: number
          branch_id: string
          created_at: string
          low_stock_threshold: number
          product_id: string
          quantity_on_hand: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "pos_branch_inventory"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      applicant_address_parts: {
        Args: { p_application_id: string }
        Returns: {
          barangay: string
          city: string
          province: string
          street: string
        }[]
      }
      applicant_notify_token: { Args: never; Returns: string }
      applicant_owns_file: {
        Args: {
          p_bucket: string
          p_email: string
          p_path: string
          p_reference_code: string
        }
        Returns: boolean
      }
      apply_pos_receipt: {
        Args: {
          _branch_id: string
          _notes: string
          _product_id: string
          _quantity: number
          _source_id: string
          _source_type: string
          _unit_cost: number
        }
        Returns: Record<string, unknown>
      }
      apply_position_system_access: {
        Args: { _access: Json; _position_id: string }
        Returns: undefined
      }
      approve_change_request: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      approve_pos_request: {
        Args: { _note?: string; _request_id: string }
        Returns: undefined
      }
      assert_entitlement_allowed: {
        Args: {
          _role_code: string
          _system: Database["public"]["Enums"]["entitlement_system"]
        }
        Returns: undefined
      }
      assert_may_review_finance_master: {
        Args: { _proposed_by: string; _what: string }
        Returns: string
      }
      bootstrap_first_administrator: {
        Args: { _email: string }
        Returns: string
      }
      can_manage_pos_catalogue: { Args: never; Returns: boolean }
      can_read_finance_master: { Args: never; Returns: boolean }
      can_read_finance_request: {
        Args: { _request_id: string }
        Returns: boolean
      }
      can_review_pos_request: {
        Args: { _request_type: Database["public"]["Enums"]["pos_request_type"] }
        Returns: boolean
      }
      cancel_pos_payment_attempt: {
        Args: { _checkout_key: string }
        Returns: undefined
      }
      cancel_pos_request: {
        Args: { _reason: string; _request_id: string }
        Returns: undefined
      }
      cancel_purchase_order_remainder: {
        Args: { _purchase_order_id: string; _reason: string }
        Returns: number
      }
      checkout_pos_sale: {
        Args: {
          _amount_tendered?: number
          _branch_id: string
          _checkout_key: string
          _items: Json
          _payment_method: string
          _payment_reference?: string
        }
        Returns: Json
      }
      close_finance_privilege: {
        Args: { _profile_id: string; _reason?: string }
        Returns: undefined
      }
      close_hr_privilege: {
        Args: { _profile_id: string; _reason: string }
        Returns: undefined
      }
      create_collection_settlement: {
        Args: {
          _branch_id?: string
          _destination_account_id: string
          _fee_amount?: number
          _kind: string
          _notes?: string
          _payment_method?: string
          _reference?: string
          _sale_ids: string[]
          _settlement_date: string
          _submit?: boolean
        }
        Returns: string
      }
      create_pos_carry_request: {
        Args: { _branch_id: string; _product_id: string; _reason: string }
        Returns: string
      }
      create_pos_category: { Args: { _name: string }; Returns: string }
      create_pos_new_product_request: {
        Args: {
          _branch_id: string
          _category_id: string
          _description?: string
          _name: string
          _reason: string
          _selling_price: number
        }
        Returns: string
      }
      create_pos_product_for_branch: {
        Args: {
          _branch_id: string
          _category_id: string
          _name: string
          _selling_price: number
        }
        Returns: string
      }
      create_pos_stock_request: {
        Args: {
          _branch_id: string
          _product_id: string
          _reason: string
          _requested_quantity: number
        }
        Returns: string
      }
      create_position_with_access: {
        Args: {
          _access?: Json
          _department_id: string
          _description: string
          _title: string
        }
        Returns: string
      }
      create_purchase_order_from_source: {
        Args: {
          _budget_id?: string
          _expected_delivery_date?: string
          _lines?: Json
          _notes?: string
          _quantity?: number
          _source_id: string
          _source_kind: string
          _submit?: boolean
          _unit_cost?: number
          _vendor_id: string
        }
        Returns: string
      }
      create_supplier_invoice: {
        Args: {
          _due_date?: string
          _invoice_date: string
          _lines?: Json
          _notes?: string
          _other_charges?: number
          _other_charges_note?: string
          _purchase_order_id: string
          _supplier_invoice_number: string
          _tax_amount?: number
        }
        Returns: string
      }
      create_supplier_payment: {
        Args: {
          _amount: number
          _method?: string
          _notes?: string
          _submit?: boolean
          _supplier_invoice_id: string
          _treasury_account_id: string
        }
        Returns: string
      }
      decline_pos_request: {
        Args: { _note: string; _request_id: string }
        Returns: undefined
      }
      delete_pos_category: {
        Args: { _category_id: string; _replacement_id?: string }
        Returns: undefined
      }
      describe_ineligibility: {
        Args: {
          _profile_id: string
          _role_code: string
          _system: Database["public"]["Enums"]["entitlement_system"]
        }
        Returns: string
      }
      describe_pos_ineligibility: {
        Args: { _profile_id: string; _role_code: string }
        Returns: string
      }
      discard_purchase_order_draft: {
        Args: { _purchase_order_id: string; _reason: string }
        Returns: undefined
      }
      employment_permits_operational_work: {
        Args: { _status: Database["public"]["Enums"]["employment_status"] }
        Returns: boolean
      }
      enqueue_applicant_notification: {
        Args: {
          _application_id: string
          _dedupe_key: string
          _event_type: string
          _payload?: Json
        }
        Returns: string
      }
      finalize_pos_payment: {
        Args: {
          _attempt_id: string
          _paid_centavos?: number
          _provider_payment_id?: string
        }
        Returns: Json
      }
      finance_request_paid: {
        Args: { _finance_request_id: string }
        Returns: number
      }
      finance_request_participants: {
        Args: never
        Returns: {
          display_name: string
          profile_id: string
        }[]
      }
      finance_request_was_submitted: {
        Args: { _request_id: string }
        Returns: boolean
      }
      generate_application_reference: { Args: never; Returns: string }
      generate_employee_number: { Args: never; Returns: string }
      generate_payslip_number: { Args: never; Returns: string }
      get_admin_pos_audit_events: {
        Args: {
          _actor_id?: string
          _branch_id?: string
          _entity_type?: Database["public"]["Enums"]["pos_audit_entity_type"]
          _event_type?: Database["public"]["Enums"]["pos_audit_event_type"]
          _from_date?: string
          _global_only?: boolean
          _limit?: number
          _offset?: number
          _to_date?: string
        }
        Returns: {
          actor_enterprise_role: Database["public"]["Enums"]["user_role"]
          actor_id: string
          actor_name: string
          actor_pos_role: Database["public"]["Enums"]["pos_role"]
          branch_id: string
          branch_name: string
          business_date: string
          description: string
          entity_id: string
          entity_name: string
          entity_type: Database["public"]["Enums"]["pos_audit_entity_type"]
          event_id: string
          event_type: Database["public"]["Enums"]["pos_audit_event_type"]
          manager_visible: boolean
          new_value: string
          occurred_at: string
          old_value: string
          total_count: number
        }[]
      }
      get_admin_pos_report_branch_comparison: {
        Args: { _from_date?: string; _to_date?: string }
        Returns: {
          average_sale: number
          branch_id: string
          branch_is_active: boolean
          branch_name: string
          fees_collected: number
          gross_product_margin: number
          gross_product_profit: number
          items_sold: number
          product_sales: number
          sales_collected: number
          total_cogs: number
          transaction_count: number
        }[]
      }
      get_admin_pos_report_summary: {
        Args: { _branch_id?: string; _from_date?: string; _to_date?: string }
        Returns: {
          average_sale: number
          date_from: string
          date_to: string
          fees_collected: number
          gross_product_margin: number
          gross_product_profit: number
          items_sold: number
          product_sales: number
          sales_collected: number
          total_cogs: number
          transaction_count: number
        }[]
      }
      get_admin_pos_report_trend: {
        Args: { _branch_id?: string; _from_date?: string; _to_date?: string }
        Returns: {
          business_date: string
          fees_collected: number
          gross_product_margin: number
          gross_product_profit: number
          items_sold: number
          product_sales: number
          sales_collected: number
          total_cogs: number
          transaction_count: number
        }[]
      }
      get_admin_transactions: {
        Args: {
          _branch_id?: string
          _from?: string
          _limit?: number
          _offset?: number
          _to?: string
        }
        Returns: {
          amount_tendered: number
          branch_id: string
          branch_name: string
          cashier_name: string
          change_given: number
          created_at: string
          fees_total: number
          item_count: number
          payment_method: string
          payment_reference: string
          sale_id: string
          status: Database["public"]["Enums"]["pos_sale_status"]
          subtotal: number
          total_amount: number
          total_count: number
        }[]
      }
      get_applicant_notifications: {
        Args: { _application_id: string }
        Returns: {
          attempts: number
          created_at: string
          event_type: string
          has_error: boolean
          id: string
          sent_at: string
          status: string
        }[]
      }
      get_branch_catalogue_management: {
        Args: { _branch_id: string }
        Returns: {
          category_id: string
          category_name: string
          image_path: string
          is_available: boolean
          name: string
          product_id: string
          product_status: Database["public"]["Enums"]["pos_product_status"]
          selling_price: number
        }[]
      }
      get_branch_category_summary: {
        Args: { _branch_id: string }
        Returns: {
          category_id: string
          color: string
          description: string
          icon: string
          is_active: boolean
          low_stock_count: number
          name: string
          offered_count: number
          out_of_stock_count: number
          product_count: number
          sort_order: number
        }[]
      }
      get_branch_deliveries: {
        Args: { _branch_id: string }
        Returns: {
          expected_delivery_date: string
          po_number: string
          product_id: string
          product_name: string
          purchase_order_item_id: string
          quantity_ordered: number
          quantity_outstanding: number
          quantity_received: number
        }[]
      }
      get_branch_inventory: {
        Args: { _branch_id: string }
        Returns: {
          category_name: string
          is_available: boolean
          is_low_stock: boolean
          low_stock_threshold: number
          product_id: string
          product_name: string
          product_status: Database["public"]["Enums"]["pos_product_status"]
          quantity_on_hand: number
        }[]
      }
      get_branch_movements: {
        Args: { _branch_id: string; _limit?: number }
        Returns: {
          actor_name: string
          created_at: string
          id: string
          movement_type: Database["public"]["Enums"]["pos_movement_type"]
          notes: string
          product_id: string
          product_name: string
          quantity_change: number
          source_type: string
          stock_after: number
          stock_before: number
        }[]
      }
      get_branch_movements_with_cost: {
        Args: { _branch_id: string; _limit?: number }
        Returns: {
          actor_name: string
          created_at: string
          id: string
          movement_type: Database["public"]["Enums"]["pos_movement_type"]
          notes: string
          product_id: string
          product_name: string
          quantity_change: number
          source_id: string
          source_type: string
          stock_after: number
          stock_before: number
          unit_cost: number
        }[]
      }
      get_branch_request_progress: {
        Args: { _branch_id: string }
        Returns: {
          po_number: string
          po_status: string
          product_id: string
          product_name: string
          progress: string
          quantity_cancelled: number
          quantity_ordered: number
          quantity_outstanding: number
          quantity_received: number
          request_id: string
          request_status: string
          requested_at: string
          requested_quantity: number
        }[]
      }
      get_branch_transactions: {
        Args: {
          _branch_id: string
          _from?: string
          _limit?: number
          _offset?: number
          _to?: string
        }
        Returns: {
          amount_tendered: number
          branch_id: string
          branch_name: string
          cashier_name: string
          change_given: number
          created_at: string
          fees_total: number
          item_count: number
          payment_method: string
          payment_reference: string
          sale_id: string
          status: Database["public"]["Enums"]["pos_sale_status"]
          subtotal: number
          total_amount: number
          total_count: number
        }[]
      }
      get_collection_settlement_items: {
        Args: { _settlement_id: string }
        Returns: {
          amount: number
          branch_name: string
          cashier_name: string
          id: string
          payment_method: string
          payment_reference: string
          pos_sale_id: string
          sold_at: string
        }[]
      }
      get_collection_settlements: {
        Args: never
        Returns: {
          branch_id: string | null
          branch_name: string | null
          created_at: string | null
          decision_reason: string | null
          destination_account_id: string | null
          destination_account_name: string | null
          destination_account_type: string | null
          fee_amount: number | null
          gross_amount: number | null
          id: string | null
          item_count: number | null
          kind: string | null
          net_amount: number | null
          notes: string | null
          payment_method: string | null
          prepared_by: string | null
          prepared_by_name: string | null
          reference: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          reviewed_by_name: string | null
          settlement_date: string | null
          settlement_no: string | null
          status: string | null
          submitted_at: string | null
          updated_at: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "collection_settlement_status"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_eligible_pos_employees: {
        Args: { _branch_id: string; _role_code: string }
        Returns: {
          department_name: string
          email: string
          employee_id: string
          employee_number: string
          full_name: string
          position_title: string
          profile_id: string
        }[]
      }
      get_expirable_pos_payments: {
        Args: { _limit?: number }
        Returns: {
          amount_centavos: number
          expires_at: string
          id: string
          provider_checkout_session_id: string
          reference_number: string
        }[]
      }
      get_finance_sales_collections: {
        Args: {
          _branch_id?: string
          _cashier_id?: string
          _from_date?: string
          _payment_method?: string
          _to_date?: string
        }
        Returns: {
          amount_collected: number
          payment_method: string
          transaction_count: number
        }[]
      }
      get_finance_sales_filters: {
        Args: { _from_date?: string; _to_date?: string }
        Returns: {
          id: string
          kind: string
          label: string
        }[]
      }
      get_finance_sales_summary: {
        Args: {
          _branch_id?: string
          _cashier_id?: string
          _from_date?: string
          _payment_method?: string
          _to_date?: string
        }
        Returns: {
          average_sale: number
          date_from: string
          date_to: string
          discounts: number
          fees_collected: number
          gross_sales: number
          items_sold: number
          net_sales: number
          refunds: number
          total_collected: number
          transaction_count: number
        }[]
      }
      get_finance_sales_transactions: {
        Args: {
          _branch_id?: string
          _cashier_id?: string
          _from_date?: string
          _limit?: number
          _offset?: number
          _payment_method?: string
          _to_date?: string
        }
        Returns: {
          branch_id: string
          branch_name: string
          cashier_id: string
          cashier_name: string
          discounts: number
          fees_total: number
          gross_sales: number
          item_count: number
          net_sales: number
          payment_method: string
          payment_reference: string
          refunds: number
          sale_id: string
          sold_at: string
          total_collected: number
          total_rows: number
        }[]
      }
      get_hr_account_candidates: {
        Args: { _hr_role?: string }
        Returns: {
          account_role: string
          department_name: string
          eligible_roles: string[]
          email: string
          employee_id: string
          employee_number: string
          full_name: string
          has_account: boolean
          position_title: string
          profile_id: string
        }[]
      }
      get_hr_accounts: {
        Args: never
        Returns: {
          account_role: string
          account_status: string
          authorizes_now: boolean
          closed_at: string
          closed_reason: string
          currently_eligible: boolean
          department_name: string
          email: string
          employee_id: string
          employment_status: string
          full_name: string
          grant_status: string
          granted_at: string
          hr_role: string
          last_login_at: string
          position_title: string
          profile_id: string
        }[]
      }
      get_invoiceable_purchase_orders: {
        Args: never
        Returns: {
          invoiced_value: number
          outstanding_value: number
          po_number: string
          purchase_order_id: string
          received_value: number
          status: string
          vendor_id: string
          vendor_name: string
        }[]
      }
      get_my_transactions: {
        Args: {
          _from?: string
          _limit?: number
          _offset?: number
          _to?: string
        }
        Returns: {
          amount_tendered: number
          branch_id: string
          branch_name: string
          cashier_name: string
          change_given: number
          created_at: string
          fees_total: number
          item_count: number
          payment_method: string
          payment_reference: string
          sale_id: string
          status: Database["public"]["Enums"]["pos_sale_status"]
          subtotal: number
          total_amount: number
          total_count: number
        }[]
      }
      get_noncompliant_pos_assignments: {
        Args: never
        Returns: {
          assignment_id: string
          branch_id: string
          branch_name: string
          department_name: string
          full_name: string
          pos_role: Database["public"]["Enums"]["pos_role"]
          position_title: string
          profile_id: string
          reason: string
        }[]
      }
      get_payable_invoices: {
        Args: never
        Returns: {
          amount_paid: number
          available_to_prepare: number
          balance_due: number
          due_date: string
          id: string
          invoice_no: string
          payment_state: string
          pending_payment_amount: number
          settlement_state: string
          supplier_invoice_number: string
          total_amount: number
          vendor_id: string
          vendor_name: string
        }[]
      }
      get_pos_carryable_products: {
        Args: { _branch_id: string }
        Returns: {
          category_name: string
          product_id: string
          product_name: string
        }[]
      }
      get_pos_catalogue: {
        Args: { _branch_id: string }
        Returns: {
          available_quantity: number
          category_id: string
          category_name: string
          image_path: string
          is_low_stock: boolean
          name: string
          product_id: string
          selling_price: number
        }[]
      }
      get_pos_categories: {
        Args: never
        Returns: {
          color: string
          icon: string
          id: string
          name: string
          sort_order: number
        }[]
      }
      get_pos_dashboard_payment_totals: {
        Args: { _branch_id: string; _on_date?: string }
        Returns: {
          amount_collected: number
          payment_method: string
          transaction_count: number
        }[]
      }
      get_pos_dashboard_summary: {
        Args: { _branch_id: string; _on_date?: string }
        Returns: {
          average_sale: number
          business_date: string
          fees_collected: number
          items_sold: number
          low_stock_count: number
          out_of_stock_count: number
          product_sales: number
          sales_collected: number
          transaction_count: number
        }[]
      }
      get_pos_dashboard_top_products: {
        Args: { _branch_id: string; _limit?: number; _on_date?: string }
        Returns: {
          product_id: string
          product_name: string
          quantity_sold: number
          sales_amount: number
        }[]
      }
      get_pos_manager_audit_events: {
        Args: {
          _actor_id?: string
          _branch_id: string
          _entity_type?: Database["public"]["Enums"]["pos_audit_entity_type"]
          _event_type?: Database["public"]["Enums"]["pos_audit_event_type"]
          _from_date?: string
          _limit?: number
          _offset?: number
          _to_date?: string
        }
        Returns: {
          actor_id: string
          actor_name: string
          branch_id: string
          branch_name: string
          business_date: string
          entity_id: string
          entity_name: string
          entity_type: Database["public"]["Enums"]["pos_audit_entity_type"]
          event_id: string
          event_type: Database["public"]["Enums"]["pos_audit_event_type"]
          new_value: string
          occurred_at: string
          old_value: string
          total_count: number
        }[]
      }
      get_pos_manager_report_payment_totals: {
        Args: { _branch_id: string; _from_date?: string; _to_date?: string }
        Returns: {
          amount_collected: number
          payment_method: string
          transaction_count: number
        }[]
      }
      get_pos_manager_report_summary: {
        Args: { _branch_id: string; _from_date?: string; _to_date?: string }
        Returns: {
          average_sale: number
          date_from: string
          date_to: string
          fees_collected: number
          items_sold: number
          product_sales: number
          sales_collected: number
          transaction_count: number
        }[]
      }
      get_pos_manager_report_top_products: {
        Args: {
          _branch_id: string
          _from_date?: string
          _limit?: number
          _to_date?: string
        }
        Returns: {
          product_id: string
          product_name: string
          quantity_sold: number
          sales_amount: number
        }[]
      }
      get_pos_manager_report_trend: {
        Args: { _branch_id: string; _from_date?: string; _to_date?: string }
        Returns: {
          business_date: string
          fees_collected: number
          items_sold: number
          product_sales: number
          sales_collected: number
          transaction_count: number
        }[]
      }
      get_pos_manager_requests: {
        Args: {
          _branch_id: string
          _limit?: number
          _offset?: number
          _status?: Database["public"]["Enums"]["pos_request_status"]
        }
        Returns: {
          branch_id: string
          branch_name: string
          product_id: string
          product_name: string
          reason: string
          request_id: string
          request_type: Database["public"]["Enums"]["pos_request_type"]
          requested_at: string
          requested_by: string
          requested_quantity: number
          requester_name: string
          review_note: string
          reviewed_at: string
          reviewer_name: string
          status: Database["public"]["Enums"]["pos_request_status"]
          total_count: number
        }[]
      }
      get_pos_report_presets: {
        Args: never
        Returns: {
          date_from: string
          date_to: string
          preset: string
          sort_order: number
        }[]
      }
      get_pos_request_queue: {
        Args: {
          _branch_id?: string
          _limit?: number
          _offset?: number
          _status?: Database["public"]["Enums"]["pos_request_status"]
        }
        Returns: {
          branch_id: string
          branch_name: string
          can_review: boolean
          product_id: string
          product_name: string
          reason: string
          request_id: string
          request_type: Database["public"]["Enums"]["pos_request_type"]
          requested_at: string
          requested_by: string
          requested_quantity: number
          requester_enterprise_role: Database["public"]["Enums"]["user_role"]
          requester_name: string
          review_note: string
          reviewed_at: string
          reviewer_name: string
          status: Database["public"]["Enums"]["pos_request_status"]
          total_count: number
        }[]
      }
      get_position_entitlements: {
        Args: never
        Returns: {
          department_id: string
          department_name: string
          position_id: string
          position_title: string
          role_code: string
          system: Database["public"]["Enums"]["entitlement_system"]
        }[]
      }
      get_procurement_demand: {
        Args: never
        Returns: {
          amount: number
          branch_id: string
          branch_name: string
          demand_state: string
          product_id: string
          purchase_order_id: string
          purchase_order_no: string
          purchase_order_status: string
          reason: string
          reference: string
          requested_at: string
          requested_by_name: string
          requested_quantity: number
          source_id: string
          source_kind: string
          title: string
        }[]
      }
      get_procurement_source: {
        Args: { _source_id: string; _source_kind: string }
        Returns: {
          amount: number
          branch_id: string
          branch_name: string
          ordered_quantity: number
          outstanding: number
          product_id: string
          product_name: string
          reference: string
          requested_by_name: string
          requested_quantity: number
          source_id: string
          source_kind: string
          title: string
        }[]
      }
      get_public_job_posting: {
        Args: { _id: string }
        Returns: {
          closing_date: string
          date_posted: string
          department_name: string
          description: string
          employment_type: string
          id: string
          position_title: string
          requirements: string
          status: string
          vacancies: number
        }[]
      }
      get_public_job_postings: {
        Args: never
        Returns: {
          closing_date: string
          date_posted: string
          department_name: string
          description: string
          employment_type: string
          id: string
          position_title: string
          requirements: string
          status: string
          vacancies: number
        }[]
      }
      get_sale_detail: { Args: { _sale_id: string }; Returns: Json }
      get_settlement_branches: {
        Args: never
        Returns: {
          id: string
          name: string
        }[]
      }
      get_supplier_payments: {
        Args: { _invoice_id?: string }
        Returns: {
          account_name: string
          amount: number
          approved_at: string
          approved_by: string
          approved_by_name: string
          created_at: string
          decision_reason: string
          id: string
          invoice_no: string
          method: string
          notes: string
          paid_at: string
          paid_by: string
          paid_by_name: string
          payment_date: string
          payment_no: string
          prepared_by: string
          prepared_by_name: string
          reference: string
          status: string
          submitted_at: string
          supplier_invoice_id: string
          supplier_invoice_number: string
          treasury_account_id: string
          vendor_name: string
        }[]
      }
      get_treasury_accounts: {
        Args: never
        Returns: {
          account_type: string | null
          balance: number | null
          branch_id: string | null
          branch_name: string | null
          created_at: string | null
          created_by: string | null
          currency: string | null
          finance_account_id: string | null
          finance_account_name: string | null
          id: string | null
          is_active: boolean | null
          last_movement_on: string | null
          movement_count: number | null
          name: string | null
          notes: string | null
          opening_balance: number | null
          opening_balance_as_of: string | null
          total_in: number | null
          total_out: number | null
          updated_at: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "treasury_account_status"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_treasury_movements: {
        Args: { _account_id?: string; _limit?: number; _offset?: number }
        Returns: {
          account_name: string
          actor_name: string
          amount: number
          created_at: string
          created_by: string
          direction: string
          id: string
          occurred_on: string
          reference: string
          source_id: string
          source_no: string
          source_type: string
          total_rows: number
          treasury_account_id: string
        }[]
      }
      get_unsettled_collections: {
        Args: {
          _branch_id?: string
          _from_date?: string
          _kind: string
          _payment_method?: string
          _to_date?: string
        }
        Returns: {
          amount: number
          branch_id: string
          branch_name: string
          cashier_name: string
          payment_method: string
          payment_reference: string
          sale_id: string
          sold_at: string
        }[]
      }
      grant_finance_privilege: {
        Args: { _finance_role: string; _profile_id: string }
        Returns: string
      }
      grant_hr_privilege: {
        Args: { _hr_role: string; _profile_id: string }
        Returns: string
      }
      has_finance_privilege: { Args: { _roles: string[] }; Returns: boolean }
      has_hr_privilege: { Args: { _roles: string[] }; Returns: boolean }
      has_pos_access: { Args: never; Returns: boolean }
      has_pos_role: {
        Args: {
          _branch_id: string
          _roles: Database["public"]["Enums"]["pos_role"][]
        }
        Returns: boolean
      }
      invoice_pending_payment: {
        Args: { _invoice_id: string }
        Returns: number
      }
      is_active_employee: { Args: never; Returns: boolean }
      is_active_finance: { Args: never; Returns: boolean }
      is_active_staff: { Args: never; Returns: boolean }
      is_admin: { Args: never; Returns: boolean }
      is_eligible_for_system_role: {
        Args: {
          _profile_id: string
          _role_code: string
          _system: Database["public"]["Enums"]["entitlement_system"]
        }
        Returns: boolean
      }
      is_hr_manager_or_admin: { Args: never; Returns: boolean }
      is_hr_staff_or_admin: { Args: never; Returns: boolean }
      lookup_application: {
        Args: { p_email: string; p_reference_code: string }
        Returns: {
          account_activated_at: string
          account_email: string
          applicant_name: string
          contract_additional_notes: string
          contract_company_policies: string
          contract_file_path: string
          contract_id: string
          contract_signed_at: string
          contract_start_date: string
          contract_status: Database["public"]["Enums"]["contract_status"]
          contract_terms: string
          department_name: string
          deployment_branch: string
          deployment_date: string
          deployment_remarks: string
          deployment_schedule_days: number[]
          deployment_schedule_end: string
          deployment_schedule_name: string
          deployment_schedule_start: string
          deployment_work_location: string
          documents: Json
          employee_basic_salary: number
          employee_benefits: string
          employee_currency: string
          employee_department: string
          employee_email: string
          employee_employment_status: Database["public"]["Enums"]["employment_status"]
          employee_employment_type: Database["public"]["Enums"]["employment_type"]
          employee_hire_date: string
          employee_number: string
          employee_position: string
          interview_location: string
          interview_meeting_link: string
          interview_mode: string
          interview_scheduled_at: string
          interview_status: Database["public"]["Enums"]["interview_status"]
          interview_type: Database["public"]["Enums"]["interview_type"]
          offer_additional_compensation: string
          offer_benefits: string
          offer_currency: string
          offer_employment_type: Database["public"]["Enums"]["employment_type"]
          offer_id: string
          offer_salary: number
          offer_start_date: string
          offer_status: Database["public"]["Enums"]["offer_status"]
          offer_working_days: string
          offer_working_hours: string
          position_employment_type: Database["public"]["Enums"]["employment_type"]
          position_title: string
          reference_code: string
          status: Database["public"]["Enums"]["application_status"]
          submitted_at: string
        }[]
      }
      lookup_application_milestones: {
        Args: { p_email: string; p_reference_code: string }
        Returns: {
          event: string
          occurred_at: string
        }[]
      }
      mark_pos_payment_state: {
        Args: {
          _attempt_id: string
          _reason?: string
          _status: Database["public"]["Enums"]["pos_payment_status"]
        }
        Returns: boolean
      }
      my_employee_id: { Args: never; Returns: string }
      my_pos_assignments: {
        Args: never
        Returns: {
          branch_id: string
          pos_role: Database["public"]["Enums"]["pos_role"]
        }[]
      }
      my_pos_branches: { Args: never; Returns: string[] }
      payment_budget_id: { Args: { _payment_id: string }; Returns: string }
      payment_can_be_submitted: {
        Args: { _payment_id: string }
        Returns: boolean
      }
      pos_audit_fee_summary: { Args: { _fees: Json }; Returns: string }
      pos_audit_is_manager_visible: {
        Args: {
          _event_type: Database["public"]["Enums"]["pos_audit_event_type"]
        }
        Returns: boolean
      }
      pos_audit_price_text: { Args: { _price: number }; Returns: string }
      pos_audit_write: {
        Args: {
          _admin_description: string
          _admin_new?: string
          _admin_old?: string
          _branch_id: string
          _entity_id: string
          _entity_name: string
          _entity_type: Database["public"]["Enums"]["pos_audit_entity_type"]
          _event_type: Database["public"]["Enums"]["pos_audit_event_type"]
          _safe_new?: string
          _safe_old?: string
        }
        Returns: undefined
      }
      pos_business_date: { Args: never; Returns: string }
      pos_business_timezone: { Args: never; Returns: string }
      pos_day_bounds: {
        Args: { _on_date?: string }
        Returns: {
          business_date: string
          day_end: string
          day_start: string
        }[]
      }
      pos_expiry_token: { Args: never; Returns: string }
      pos_fees_are_valid: { Args: { _fees: Json }; Returns: boolean }
      pos_max_cart_lines: { Args: never; Returns: number }
      pos_max_line_quantity: { Args: never; Returns: number }
      pos_page_size: { Args: { _requested: number }; Returns: number }
      pos_payment_is_cash: { Args: { _method: string }; Returns: boolean }
      pos_payment_ttl_minutes: { Args: never; Returns: number }
      pos_provider_family: { Args: { _method: string }; Returns: string }
      pos_qr_branch_id: { Args: { _object_name: string }; Returns: string }
      pos_report_bounds: {
        Args: { _from_date?: string; _to_date?: string }
        Returns: {
          date_from: string
          date_to: string
          period_end: string
          period_start: string
        }[]
      }
      pos_request_audit: {
        Args: {
          _admin_description: string
          _event_type: Database["public"]["Enums"]["pos_audit_event_type"]
          _new: string
          _old: string
          _request: Database["public"]["Tables"]["pos_inventory_requests"]["Row"]
        }
        Returns: undefined
      }
      pos_request_ordered_quantity: {
        Args: { _request_id: string }
        Returns: number
      }
      pos_sale_receipt: { Args: { _sale_id: string }; Returns: Json }
      price_pos_cart: {
        Args: { _branch_id: string; _items: Json }
        Returns: Json
      }
      purchase_order_commitment: {
        Args: { _purchase_order_id: string }
        Returns: number
      }
      purchase_order_paid: {
        Args: { _purchase_order_id: string }
        Returns: number
      }
      receive_pos_stock: {
        Args: {
          _branch_id: string
          _notes?: string
          _product_id: string
          _quantity: number
          _unit_cost?: number
        }
        Returns: {
          average_unit_cost: number
          branch_id: string
          created_at: string
          low_stock_threshold: number
          product_id: string
          quantity_on_hand: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "pos_branch_inventory"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      receive_procurement_stock: {
        Args: {
          _delivery_reference?: string
          _idempotency_key?: string
          _purchase_order_item_id: string
          _quantity: number
        }
        Returns: string
      }
      recompute_payroll_period_status: {
        Args: { p_period_id: string }
        Returns: undefined
      }
      reconcile_finance_privilege: {
        Args: { _profile_id: string }
        Returns: undefined
      }
      reconcile_hr_privilege: {
        Args: { _profile_id: string }
        Returns: undefined
      }
      reconcile_pos_access: {
        Args: { _profile_id: string }
        Returns: undefined
      }
      record_application_milestone: {
        Args: { _application_id: string; _event: string; _occurred_at?: string }
        Returns: undefined
      }
      reject_change_request: {
        Args: { p_reason: string; p_request_id: string }
        Returns: undefined
      }
      rename_pos_category: {
        Args: { _category_id: string; _name: string }
        Returns: undefined
      }
      reorder_pos_category: {
        Args: { _category_id: string; _direction: number }
        Returns: undefined
      }
      request_applicant_notification_run: { Args: never; Returns: undefined }
      require_business_reason: {
        Args: { _reason: string; _what: string }
        Returns: string
      }
      respond_to_job_offer: {
        Args: {
          p_decision: string
          p_decline_notes?: string
          p_decline_reason?: string
          p_email: string
          p_reference_code: string
        }
        Returns: string
      }
      review_budget: {
        Args: { _approve: boolean; _budget_id: string; _note?: string }
        Returns: undefined
      }
      review_finance_category: {
        Args: { _approve: boolean; _category_id: string; _note?: string }
        Returns: undefined
      }
      review_vendor: {
        Args: { _approve: boolean; _note?: string; _vendor_id: string }
        Returns: undefined
      }
      set_low_stock_threshold: {
        Args: { _branch_id: string; _product_id: string; _threshold: number }
        Returns: {
          average_unit_cost: number
          branch_id: string
          created_at: string
          low_stock_threshold: number
          product_id: string
          quantity_on_hand: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "pos_branch_inventory"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_pos_branch_selling_price: {
        Args: { _branch_id: string; _price: number; _product_id: string }
        Returns: undefined
      }
      set_pos_product_image: {
        Args: { _image_path: string; _product_id: string }
        Returns: undefined
      }
      set_position_entitlement: {
        Args: {
          _granted: boolean
          _position_id: string
          _role_code: string
          _system: Database["public"]["Enums"]["entitlement_system"]
        }
        Returns: undefined
      }
      settlement_gross: { Args: { _settlement_id: string }; Returns: number }
      submit_job_application: {
        Args: {
          p_address: string
          p_barangay?: string
          p_birth_date?: string
          p_city?: string
          p_cover_letter?: string
          p_email: string
          p_first_name: string
          p_gender?: string
          p_government_id_path?: string
          p_job_posting_id: string
          p_last_name: string
          p_middle_name?: string
          p_nationality?: string
          p_phone: string
          p_province?: string
          p_resume_path: string
        }
        Returns: {
          applicant_id: string
          application_id: string
          reference_code: string
        }[]
      }
      supplier_invoice_match: {
        Args: { _supplier_invoice_id: string }
        Returns: {
          billable_quantity: number
          cancelled_quantity: number
          description: string
          effective_quantity: number
          invoice_line_value: number
          invoice_quantity: number
          invoice_unit_cost: number
          line_id: string
          ordered_quantity: number
          po_line_value: number
          po_unit_cost: number
          previously_invoiced: number
          price_matched: boolean
          purchase_order_item_id: string
          quantity_matched: boolean
          received_quantity: number
          verdict: string
        }[]
      }
      sync_employment_statuses: { Args: never; Returns: undefined }
      transition_collection_settlement: {
        Args: { _reason?: string; _settlement_id: string; _to_status: string }
        Returns: undefined
      }
      transition_finance_request: {
        Args: {
          _paid_from_account_id?: string
          _payment_reference?: string
          _remarks?: string
          _request_id: string
          _to_status: string
        }
        Returns: undefined
      }
      transition_purchase_order: {
        Args: {
          _purchase_order_id: string
          _remarks?: string
          _to_status: string
        }
        Returns: undefined
      }
      transition_supplier_invoice: {
        Args: {
          _remarks?: string
          _supplier_invoice_id: string
          _to_status: string
        }
        Returns: undefined
      }
      transition_supplier_payment: {
        Args: {
          _payment_date?: string
          _payment_id: string
          _reason?: string
          _reference?: string
          _to_status: string
        }
        Returns: undefined
      }
      treasury_account_balance: {
        Args: { _account_id: string }
        Returns: number
      }
      update_pos_product_details: {
        Args: { _category_id: string; _name: string; _product_id: string }
        Returns: undefined
      }
      validate_pos_payment_reference: {
        Args: { _payment_method: string; _payment_reference: string }
        Returns: string
      }
    }
    Enums: {
      account_status: "active" | "inactive"
      applicant_notification_status:
        | "pending"
        | "processing"
        | "sent"
        | "failed"
      application_status:
        | "submitted"
        | "under_review"
        | "qualified"
        | "rejected"
        | "interview_scheduled"
        | "offered"
        | "hired"
        | "closed"
        | "deployed"
      attendance_status:
        | "present"
        | "absent"
        | "late"
        | "on_leave"
        | "half_day"
        | "rest_day"
        | "official_business"
        | "work_from_home"
      change_request_operation: "create" | "update" | "delete"
      change_request_status: "pending" | "approved" | "rejected"
      contract_status: "draft" | "printed" | "signed"
      employment_status:
        | "active"
        | "on_leave"
        | "resigned"
        | "terminated"
        | "retired"
      employment_type: "regular" | "part_time"
      entitlement_system: "hrms" | "pos" | "fms"
      interview_status:
        | "scheduled"
        | "passed"
        | "failed"
        | "completed"
        | "cancelled"
      interview_type: "initial" | "final"
      job_posting_status: "draft" | "open" | "closed"
      leave_request_status: "pending" | "approved" | "rejected" | "cancelled"
      offer_status: "pending" | "accepted" | "declined"
      payroll_status:
        | "draft"
        | "generated"
        | "pending_approval"
        | "approved"
        | "rejected"
        | "released"
      pos_audit_entity_type:
        | "branch_assignment"
        | "branch_settings"
        | "product"
        | "category"
        | "branch_product"
        | "inventory_threshold"
        | "inventory_request"
      pos_audit_event_type:
        | "fees_changed"
        | "payment_qr_updated"
        | "payment_qr_removed"
        | "branch_product_added"
        | "branch_product_removed"
        | "branch_selling_price_changed"
        | "product_offered"
        | "product_stopped"
        | "low_stock_threshold_changed"
        | "assignment_granted"
        | "assignment_revoked"
        | "product_created"
        | "product_updated"
        | "product_archived"
        | "product_restored"
        | "category_created"
        | "category_updated"
        | "category_archived"
        | "category_restored"
        | "category_reordered"
        | "category_deleted"
        | "stock_request_created"
        | "stock_request_cancelled"
        | "stock_request_approved"
        | "stock_request_declined"
      pos_movement_type: "receipt" | "adjustment_in" | "adjustment_out" | "sale"
      pos_payment_status:
        | "pending"
        | "paid"
        | "paid_unfulfilled"
        | "failed"
        | "expired"
        | "cancelled"
      pos_product_status: "draft" | "active" | "archived"
      pos_request_status: "pending" | "approved" | "declined" | "cancelled"
      pos_request_type: "restock" | "carry_existing_product" | "new_product"
      pos_role: "manager" | "cashier"
      pos_sale_status: "completed"
      report_format: "pdf" | "docx" | "excel"
      user_role:
        | "admin"
        | "hr_staff"
        | "employee"
        | "hr_manager"
        | "finance_staff"
        | "finance_manager"
        | "accountant"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      account_status: ["active", "inactive"],
      applicant_notification_status: [
        "pending",
        "processing",
        "sent",
        "failed",
      ],
      application_status: [
        "submitted",
        "under_review",
        "qualified",
        "rejected",
        "interview_scheduled",
        "offered",
        "hired",
        "closed",
        "deployed",
      ],
      attendance_status: [
        "present",
        "absent",
        "late",
        "on_leave",
        "half_day",
        "rest_day",
        "official_business",
        "work_from_home",
      ],
      change_request_operation: ["create", "update", "delete"],
      change_request_status: ["pending", "approved", "rejected"],
      contract_status: ["draft", "printed", "signed"],
      employment_status: [
        "active",
        "on_leave",
        "resigned",
        "terminated",
        "retired",
      ],
      employment_type: ["regular", "part_time"],
      entitlement_system: ["hrms", "pos", "fms"],
      interview_status: [
        "scheduled",
        "passed",
        "failed",
        "completed",
        "cancelled",
      ],
      interview_type: ["initial", "final"],
      job_posting_status: ["draft", "open", "closed"],
      leave_request_status: ["pending", "approved", "rejected", "cancelled"],
      offer_status: ["pending", "accepted", "declined"],
      payroll_status: [
        "draft",
        "generated",
        "pending_approval",
        "approved",
        "rejected",
        "released",
      ],
      pos_audit_entity_type: [
        "branch_assignment",
        "branch_settings",
        "product",
        "category",
        "branch_product",
        "inventory_threshold",
        "inventory_request",
      ],
      pos_audit_event_type: [
        "fees_changed",
        "payment_qr_updated",
        "payment_qr_removed",
        "branch_product_added",
        "branch_product_removed",
        "branch_selling_price_changed",
        "product_offered",
        "product_stopped",
        "low_stock_threshold_changed",
        "assignment_granted",
        "assignment_revoked",
        "product_created",
        "product_updated",
        "product_archived",
        "product_restored",
        "category_created",
        "category_updated",
        "category_archived",
        "category_restored",
        "category_reordered",
        "category_deleted",
        "stock_request_created",
        "stock_request_cancelled",
        "stock_request_approved",
        "stock_request_declined",
      ],
      pos_movement_type: ["receipt", "adjustment_in", "adjustment_out", "sale"],
      pos_payment_status: [
        "pending",
        "paid",
        "paid_unfulfilled",
        "failed",
        "expired",
        "cancelled",
      ],
      pos_product_status: ["draft", "active", "archived"],
      pos_request_status: ["pending", "approved", "declined", "cancelled"],
      pos_request_type: ["restock", "carry_existing_product", "new_product"],
      pos_role: ["manager", "cashier"],
      pos_sale_status: ["completed"],
      report_format: ["pdf", "docx", "excel"],
      user_role: [
        "admin",
        "hr_staff",
        "employee",
        "hr_manager",
        "finance_staff",
        "finance_manager",
        "accountant",
      ],
    },
  },
} as const

