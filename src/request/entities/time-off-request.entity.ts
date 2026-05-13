import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum RequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  HCM_SUBMITTED = 'HCM_SUBMITTED',
  HCM_FAILED = 'HCM_FAILED',
}

export enum LeaveType {
  VACATION = 'VACATION',
  SICK = 'SICK',
  PERSONAL = 'PERSONAL',
  BEREAVEMENT = 'BEREAVEMENT',
  OTHER = 'OTHER',
}

/**
 * Lifecycle of a time-off request:
 *
 *  PENDING → APPROVED → HCM_SUBMITTED (terminal: committed to HCM)
 *         → REJECTED                  (terminal: no balance change)
 *  PENDING → CANCELLED                (terminal: balance restored)
 *  APPROVED → HCM_FAILED             (requires manual intervention / retry)
 *  APPROVED → CANCELLED               (balance restored, HCM informed)
 */
@Entity('time_off_requests')
@Index(['employeeId', 'status'])
@Index(['locationId'])
@Index(['startDate', 'endDate'])
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  @Column()
  leaveType: LeaveType;

  @Column({ type: 'float' })
  daysRequested: number;

  @Column()
  startDate: string; // ISO date string: YYYY-MM-DD

  @Column()
  endDate: string; // ISO date string: YYYY-MM-DD

  @Column({ default: RequestStatus.PENDING })
  status: RequestStatus;

  @Column({ nullable: true })
  reason: string;

  @Column({ nullable: true })
  managerComment: string;

  @Column({ nullable: true })
  reviewedBy: string;

  @Column({ nullable: true })
  reviewedAt: Date;

  @Column({ nullable: true })
  hcmTransactionId: string;

  @Column({ nullable: true })
  hcmSubmittedAt: Date;

  /**
   * Number of times we attempted to push this request to HCM after approval.
   * Used for retry logic and alerting.
   */
  @Column({ type: 'integer', default: 0 })
  hcmRetryCount: number;

  @Column({ nullable: true })
  hcmLastErrorMessage: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
