import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum AuditAction {
  BALANCE_UPDATED = 'BALANCE_UPDATED',
  BALANCE_SYNCED = 'BALANCE_SYNCED',
  REQUEST_CREATED = 'REQUEST_CREATED',
  REQUEST_APPROVED = 'REQUEST_APPROVED',
  REQUEST_REJECTED = 'REQUEST_REJECTED',
  REQUEST_CANCELLED = 'REQUEST_CANCELLED',
  HCM_PUSH_SUCCESS = 'HCM_PUSH_SUCCESS',
  HCM_PUSH_FAILED = 'HCM_PUSH_FAILED',
  BATCH_SYNC_STARTED = 'BATCH_SYNC_STARTED',
  BATCH_SYNC_COMPLETED = 'BATCH_SYNC_COMPLETED',
}

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  action: AuditAction;

  @Column({ nullable: true })
  employeeId: string;

  @Column({ nullable: true })
  locationId: string;

  @Column({ nullable: true })
  requestId: string;

  @Column({ type: 'simple-json', nullable: true })
  before: Record<string, unknown> | null;

  @Column({ type: 'simple-json', nullable: true })
  after: Record<string, unknown> | null;

  @Column({ nullable: true })
  performedBy: string;

  @Column({ nullable: true })
  notes: string;

  @CreateDateColumn()
  createdAt: Date;
}
