import * as React from 'react'
import { Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useSystemSettings, useUpdateSystemSettings } from '@/hooks/useSystemSettings'

export default function SettingsPage() {
  const { data, isLoading } = useSystemSettings()
  const updateSettings = useUpdateSystemSettings()
  const [companyName, setCompanyName] = React.useState('')

  React.useEffect(() => {
    if (data) {
      setCompanyName(data.company_name ?? '')
    }
  }, [data])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await updateSettings.mutateAsync({ company_name: companyName })
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground">System Settings</h2>
        <p className="text-sm text-muted-foreground">Organization-wide defaults used across JMAC Enterprise.</p>
      </div>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>
            These values are referenced by reports, payslips, and dashboard formatting. The system uses your browser's
            local time automatically — there's no timezone to configure.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={onSubmit}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="company_name">Company name</Label>
                <Input
                  id="company_name"
                  placeholder="Your Company Name"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                />
              </div>
              <Button type="submit" className="mt-2 w-fit" loading={updateSettings.isPending}>
                <Save className="h-4 w-4" />
                Save settings
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
