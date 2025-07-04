/**
 * Push notifications custom hook
 * Handles state management and API calls for push notification functionality
 */

import { useEffect, useState } from 'preact/hooks'
import { pushManager } from '../lib/push-manager'
import type { ActiveTab, NotificationLog, NotificationRule } from '../types/push'

export function usePushNotifications() {
  // State management
  const [isAdminSubscribed, setIsAdminSubscribed] = useState(false)
  const [permission, setPermission] = useState<NotificationPermission | null>(null)
  const [loading, setLoading] = useState(false)
  const [rules, setRules] = useState<NotificationRule[]>([])
  const [logs, setLogs] = useState<NotificationLog[]>([])
  const [vapidPublicKey, setVapidPublicKey] = useState<string>('')
  const [activeTab, setActiveTab] = useState<ActiveTab>('settings')

  // Initialize on component mount
  useEffect(() => {
    initializePush()
    fetchRules()
    fetchLogs()
    fetchVapidPublicKey()
    checkAdminSubscription()
  }, [])

  // Push manager initialization
  const initializePush = async () => {
    await pushManager.initialize()
    setPermission(pushManager.getPermissionStatus())
  }

  // API calls
  const fetchVapidPublicKey = async () => {
    try {
      const response = await fetch('/api/push/vapid-public-key')
      if (response.ok) {
        const data = await response.json()
        setVapidPublicKey(data.publicKey)
      }
    } catch (error) {
      console.error('Failed to fetch VAPID public key:', error)
    }
  }

  const checkAdminSubscription = async () => {
    try {
      const response = await fetch('/api/push/admin/subscription', {
        credentials: 'include',
      })
      if (response.ok) {
        const data = await response.json()
        setIsAdminSubscribed(data.isSubscribed)
      }
    } catch (error) {
      console.error('Failed to check admin subscription:', error)
    }
  }

  const fetchRules = async () => {
    try {
      const response = await fetch('/api/push/rules', {
        credentials: 'include',
      })
      if (response.ok) {
        const data = await response.json()
        setRules(data.rules || [])
      }
    } catch (error) {
      console.error('Failed to fetch rules:', error)
    }
  }

  const fetchLogs = async () => {
    try {
      const response = await fetch('/api/push/logs?limit=50', {
        credentials: 'include',
      })
      if (response.ok) {
        const data = await response.json()
        setLogs(data.logs || [])
      }
    } catch (error) {
      console.error('Failed to fetch logs:', error)
    }
  }

  // Admin subscription handlers
  const handleAdminSubscribe = async () => {
    setLoading(true)
    try {
      const result = await pushManager.adminSubscribe()
      if (result.success) {
        setIsAdminSubscribed(true)
        setPermission('granted')
        alert('Successfully subscribed to push notifications for testing!')
      } else {
        alert(`Failed to subscribe: ${result.error}`)
      }
    } catch (error) {
      alert(`Error: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  const handleAdminUnsubscribe = async () => {
    setLoading(true)
    try {
      const result = await pushManager.adminUnsubscribe()
      if (result.success) {
        setIsAdminSubscribed(false)
        alert('Successfully unsubscribed from push notifications!')
      } else {
        alert(`Failed to unsubscribe: ${result.error}`)
      }
    } catch (error) {
      alert(`Error: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  const handleAdminTestNotification = async () => {
    setLoading(true)
    try {
      const result = await pushManager.sendAdminTestNotification()
      if (result.success) {
        alert('Test notification sent! Check your notifications.')
        fetchLogs() // Refresh logs after sending
      } else {
        alert(`Failed to send test notification: ${result.error}`)
      }
    } catch (error) {
      alert(`Error: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  // Rule management handlers
  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('Are you sure you want to delete this rule?')) return

    try {
      const response = await fetch(`/api/push/rules/${ruleId}`, {
        method: 'DELETE',
        credentials: 'include',
      })

      if (response.ok) {
        fetchRules()
        alert('Rule deleted successfully')
      } else {
        alert('Failed to delete rule')
      }
    } catch (error) {
      console.error('Failed to delete rule:', error)
      alert('Error deleting rule')
    }
  }

  const handleToggleRule = async (rule: NotificationRule) => {
    try {
      const response = await fetch(`/api/push/rules/${rule.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          ...rule,
          enabled: !rule.enabled,
        }),
      })

      if (response.ok) {
        fetchRules()
      } else {
        alert('Failed to toggle rule')
      }
    } catch (error) {
      console.error('Failed to toggle rule:', error)
      alert('Error toggling rule')
    }
  }

  return {
    // State
    isAdminSubscribed,
    permission,
    loading,
    rules,
    logs,
    vapidPublicKey,
    activeTab,
    setActiveTab,
    setLoading,

    // Actions
    handleAdminSubscribe,
    handleAdminUnsubscribe,
    handleAdminTestNotification,
    handleDeleteRule,
    handleToggleRule,
    fetchRules,
    fetchLogs,
  }
}
