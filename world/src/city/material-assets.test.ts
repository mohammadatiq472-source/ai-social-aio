import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { asphaltMaterial, pavingMaterial, type SurfaceMaps } from './materials';

const root = new URL('../../assets/city/materials/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));

describe('街区真实PBR资产', () => {
  it('两套材料有来源、作者、CC0许可，运行贴图总量受控', () => {
    expect(manifest.license).toBe('CC0-1.0');
    expect(manifest.provider).toBe('Poly Haven');
    expect(Object.keys(manifest.materials).sort()).toEqual(['asphalt', 'granite']);
    let total = 0;
    for (const material of Object.values(manifest.materials) as any[]) {
      expect(material.source.startsWith('https://polyhaven.com/')).toBe(true);
      expect(material.author.length).toBeGreaterThan(0);
      expect(Object.keys(material.maps).sort()).toEqual(['arm', 'color', 'normal']);
      for (const map of Object.values(material.maps) as any[]) total += map.bytes;
    }
    expect(total).toBeLessThan(180000);
  });
  it('全部运行贴图的字节数与SHA256匹配清单', () => {
    for (const material of Object.values(manifest.materials) as any[]) {
      for (const map of Object.values(material.maps) as any[]) {
        const bytes = readFileSync(new URL(map.file, root));
        expect(bytes.length).toBe(map.bytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(map.sha256);
      }
    }
  });
  it('颜色与数据贴图空间分离，法线来自OpenGL版本', () => {
    for (const material of Object.values(manifest.materials) as any[]) {
      expect(material.maps.color.colorSpace).toBe('sRGB');
      expect(material.maps.normal.colorSpace).toBe('linear');
      expect(material.maps.arm.colorSpace).toBe('linear');
      expect(material.maps.normal.sourceUrl).toContain('_nor_gl_');
      expect(material.maps.color.pixels).toEqual([512, 512]);
      expect(material.maps.normal.pixels).toEqual([256, 256]);
    }
  });
  it('石材和道路同时接入颜色、法线、粗糙度与AO，不只换颜色', () => {
    const maps: SurfaceMaps = { color: new THREE.Texture(), normal: new THREE.Texture(), arm: new THREE.Texture() };
    for (const create of [pavingMaterial, asphaltMaterial]) {
      const material = create(maps);
      expect(material.map).toBe(maps.color);
      expect(material.normalMap).toBe(maps.normal);
      expect(material.roughnessMap).toBe(maps.arm);
      expect(material.aoMap).toBe(maps.arm);
      expect(material.normalScale.x).toBeGreaterThan(0);
      material.dispose();
    }
    Object.values(maps).forEach(map => map.dispose());
  });
});
