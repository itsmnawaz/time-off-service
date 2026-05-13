import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum SyncType {
  REALTIME = 'REALTIME',
  BATCH = 'BATCH',
  WEBHOOK = 'WEBHOOK',
}

export enum SyncStatus {
  SUCCESS = 'SUCCESS',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
}

@Entity('sync_logs')
export class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  syncType: SyncType;

  @Column()
  status: SyncStatus;

  @Column({ nullable: true })
  employeeId: string;

  @Column({ nullable: true })
  locationId: string;

  @Column({ type: 'integer', default: 0 })
  recordsProcessed: number;

  @Column({ type: 'integer', default: 0 })
  recordsUpdated: number;

  @Column({ type: 'integer', default: 0 })
  recordsFailed: number;

  @Column({ nullable: true })
  errorMessage: string;

  @Column({ type: 'simple-json', nullable: true })
  details: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}
