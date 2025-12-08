import { Component, OnInit, ViewChild } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatBadgeModule } from '@angular/material/badge';
import { NotificationsService, NotificationItem } from '../services/notifications.service';

@Component({
  selector: 'app-notifications-menu',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    DatePipe,
    MatMenuModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatBadgeModule
  ],
  templateUrl: './notifications-menu.component.html',
  styleUrl: './notifications-menu.component.scss'
})
export class NotificationsMenuComponent implements OnInit {
  @ViewChild(MatMenuTrigger) menuTrigger?: MatMenuTrigger;

  notifications: NotificationItem[] = [];
  loading = false;
  unreadCount = 0;
  private readonly menuLimit = 5;

  constructor(
    private notificationsService: NotificationsService,
    private snackBar: MatSnackBar,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.refreshBadge();
  }

  onMenuOpened(): void {
    this.loadUnread();
  }

  refreshBadge(): void {
    this.notificationsService.list({ status: 'unread', limit: this.menuLimit }).subscribe({
      next: ({ items }) => {
        this.unreadCount = items.length;
        this.notifications = items;
      },
      error: () => {
        this.unreadCount = 0;
      }
    });
  }

  loadUnread(): void {
    this.loading = true;
    this.notificationsService.list({ status: 'unread', limit: this.menuLimit }).subscribe({
      next: ({ items }) => {
        this.notifications = items;
        this.unreadCount = items.length;
        this.loading = false;
      },
      error: () => {
        this.loading = false;
        this.snackBar.open('Nem sikerült betölteni az értesítéseket.', 'Bezár', { duration: 2500 });
      }
    });
  }

  openNotification(notification: NotificationItem): void {
    const downloadUrl = notification.data?.downloadUrl;
    const route = notification.meta?.route;

    if (downloadUrl) {
      window.open(downloadUrl, '_blank');
    } else if (route) {
      const query = notification.meta?.query;
      this.router.navigate([route], { queryParams: query || undefined });
    }

    this.markRead(notification);
    this.menuTrigger?.closeMenu();
  }

  markRead(notification: NotificationItem): void {
    if (notification.status === 'read') return;
    this.notificationsService.markRead(notification._id).subscribe({
      next: () => {
        notification.status = 'read';
        this.refreshBadge();
      }
    });
  }

  markAllRead(event?: MouseEvent): void {
    event?.stopPropagation();
    this.notificationsService.markAllRead().subscribe({
      next: () => {
        this.notifications = [];
        this.unreadCount = 0;
        this.snackBar.open('Minden értesítés olvasottnak jelölve.', undefined, { duration: 2500 });
        this.menuTrigger?.closeMenu();
      },
      error: () => this.snackBar.open('Nem sikerült frissíteni az értesítéseket.', 'Bezár', { duration: 2500 })
    });
  }

  viewAll(event?: MouseEvent): void {
    event?.stopPropagation();
    this.menuTrigger?.closeMenu();
    this.router.navigate(['/notifications']);
  }
}
