'use client'
import { useState, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

const CATEGORIES = ['all', 'menu', 'marketing', 'shoot', 'kds', 'general'] as const
type Category = typeof CATEGORIES[number]

interface MediaAsset {
  id: string
  url: string
  filename: string
  contentType: string
  category: string
  createdAt: string
}

export default function MediaLibraryPage() {
  const [category, setCategory] = useState<Category>('all')
  const [uploading, setUploading] = useState(false)
  const [uploadCat, setUploadCat] = useState<Exclude<Category, 'all'>>('general')
  const [uploadError, setUploadError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()

  const qs = category !== 'all' ? `?category=${category}` : ''
  const { data, isLoading } = useQuery<{ data: MediaAsset[]; hasMore: boolean }>({
    queryKey: ['media', category],
    queryFn: () => api.get(`/media${qs}`),
  })

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    setUploading(true)
    setUploadError('')

    try {
      const token = useAuthStore.getState().token   // F43

      for (const file of files) {
        const params = new URLSearchParams({ filename: file.name, contentType: file.type, category: uploadCat })
        const res = await fetch(`${API_URL}/api/v1/media/upload-url?${params}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!res.ok) throw new Error('Failed to get upload URL')
        const { uploadUrl } = await res.json() as { uploadUrl: string }
        await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })
      }

      void qc.invalidateQueries({ queryKey: ['media'] })
    } catch {
      setUploadError('Upload failed — check R2 configuration in backend .env')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function copyUrl(url: string) {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(url)
      setTimeout(() => setCopied(null), 2000)
    })
  }

  async function deleteAsset(id: string) {
    if (!confirm('Remove this asset from the library?')) return
    await api.delete(`/media/${id}`)
    void qc.invalidateQueries({ queryKey: ['media'] })
  }

  const assets = data?.data ?? []

  return (
    <div className="min-h-screen bg-kds-bg p-6">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black text-kds-text">Media Library</h1>
          <p className="text-sm text-kds-subtext mt-1">Upload and manage images for menu items, marketing shoots, and KDS displays.</p>
        </div>

        {/* Upload controls */}
        <div className="flex items-center gap-3">
          <select
            value={uploadCat}
            onChange={(e) => setUploadCat(e.target.value as Exclude<Category, 'all'>)}
            className="rounded-lg border border-kds-border bg-kds-card text-kds-text px-3 py-2 text-sm focus:border-kds-green focus:outline-none"
          >
            <option value="menu">Menu</option>
            <option value="marketing">Marketing</option>
            <option value="shoot">Shoot</option>
            <option value="kds">KDS</option>
            <option value="general">General</option>
          </select>
          <label className={`cursor-pointer rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
            {uploading ? 'Uploading…' : '+ Upload Images'}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={handleUpload}
            />
          </label>
        </div>
      </div>

      {uploadError && (
        <div className="mb-4 rounded-xl border border-kds-red bg-kds-red/10 p-3 text-sm text-kds-red">{uploadError}</div>
      )}

      {/* Category filter */}
      <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            className={`shrink-0 rounded-lg px-4 py-2 text-sm font-semibold capitalize transition-colors ${
              cat === category ? 'bg-kds-green text-black' : 'bg-kds-card text-kds-subtext hover:text-kds-text'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-kds-subtext">Loading…</p>}

      {!isLoading && assets.length === 0 && (
        <div className="text-center py-20">
          <p className="text-4xl mb-3">📷</p>
          <p className="text-kds-subtext">No images yet in this category</p>
          <p className="text-xs text-kds-subtext mt-1">Use the Upload button above to add images</p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {assets.map((asset) => (
          <div key={asset.id} className="group relative rounded-xl overflow-hidden border border-kds-border bg-kds-card">
            <img
              src={asset.url}
              alt={asset.filename}
              className="h-36 w-full object-cover"
              loading="lazy"
            />
            <div className="p-2">
              <p className="text-xs text-kds-text truncate" title={asset.filename}>{asset.filename}</p>
              <p className="text-xs text-kds-subtext capitalize">{asset.category}</p>
            </div>

            {/* Hover overlay */}
            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2 p-3">
              <button
                onClick={() => copyUrl(asset.url)}
                className="w-full rounded-lg bg-kds-green text-black text-xs font-bold py-2 hover:opacity-90"
              >
                {copied === asset.url ? '✓ Copied!' : 'Copy URL'}
              </button>
              <button
                onClick={() => void deleteAsset(asset.id)}
                className="w-full rounded-lg border border-kds-red text-kds-red text-xs py-1.5 hover:bg-kds-red/20"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {data?.hasMore && (
        <p className="mt-6 text-center text-xs text-kds-subtext">Showing first 50 — add category filter to narrow results</p>
      )}
    </div>
  )
}
